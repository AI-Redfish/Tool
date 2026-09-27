"""core 对外 API：Context + run_tool 统一分发（cli.py / mcp_server.py 只调用这里）。

遵循 server-py 同构模式：TOOLS 元数据是单一事实来源，本模块把工具名+参数 dict
变为统一 envelope；所有错误收敛为 envelope.error，绝不向适配器抛裸异常。
"""

import os
import sys
import threading
import time
import traceback

from . import winapi
from .config import load_config
from .envelope import Budget, Metrics, cancelled, envelope, failed
from .errors import CancelledSignal, JevError, err
from .judge import JevClient
from .ledger import Ledger
from .session import RefRegistry
from .worker import UiaWorker, format_internal_error

# 取消注册表：MCP notifications/cancelled 与 CLI SIGINT 都通过它协作取消
_cancel_lock = threading.Lock()
_cancel_events: dict[str, threading.Event] = {}


def register_cancel(token: str) -> threading.Event:
    ev = threading.Event()
    with _cancel_lock:
        _cancel_events[token] = ev
    return ev


def cancel_token(token: str) -> bool:
    with _cancel_lock:
        ev = _cancel_events.get(token)
    if ev is not None:
        ev.set()
        return True
    return False


def _release_cancel(token: str) -> None:
    with _cancel_lock:
        _cancel_events.pop(token, None)


class Context:
    """一次 run_tool 调用的执行上下文（连接 config/worker/registry/judge/ledger/预算）。"""

    def __init__(self, cfg: dict, *, session_id: str, dry_run: bool, cancel: threading.Event | None,
                 env: dict | None = None, run_timeout_ms: int | None = None):
        self.cfg = cfg
        self.env = dict(os.environ if env is None else env)
        self.session_id = session_id or "default"
        self.dry_run = dry_run
        self.cancel = cancel
        self.worker = UiaWorker()
        self.registry = RefRegistry(cfg["session"]["dir"], self.session_id, cfg["session"]["ttlMs"])
        self.ledger = Ledger(cfg["runtime"]["logDir"], cfg["log"]["actions"])
        self.metrics = Metrics()
        self.budget = Budget(cfg, run_timeout_ms=run_timeout_ms)
        self._jev: JevClient | None = None
        # 窗口过滤参数（desktop_act/execute/run）
        self.args_app: str | None = None
        self.args_title: str | None = None
        self.args_window_id: int | None = None
        winapi.ensure_dpi_awareness()
        self.artifacts_dir_cached = self.artifacts_dir()

    # -- 资源 ------------------------------------------------------------

    def artifacts_dir(self) -> str:
        d = self.cfg["runtime"]["artifactsDir"]
        os.makedirs(d, exist_ok=True)
        return d

    def jev_required(self) -> JevClient:
        if self._jev is None:
            self._jev = JevClient(self.cfg, self.metrics, env=self.env)
        return self._jev

    def resolve_default_window(self) -> int | None:
        """缺省窗口：会话最近窗口（存活）→ None（由调用方决定是否回退前台）。"""
        w = self.registry.last_window()
        if w and w.get("hwnd") and winapi.is_window(w["hwnd"]):
            return w["hwnd"]
        return None

    def window_info(self, hwnd: int) -> dict:
        rect = winapi.window_rect(hwnd) or (0, 0, 0, 0)
        pid = winapi.window_pid(hwnd)
        return {"hwnd": hwnd, "pid": pid, "title": winapi.window_title(hwnd),
                "rect": rect, "process": winapi._process_name(pid),
                "class": winapi._window_class_name(hwnd), "foreground": False, "minimized": False}

    def pick_window(self, args: dict):
        """从工具参数解析目标窗口（严格模式）；返回 winapi.WindowInfo 或 None（无窗口类工具）。"""
        from .targeting import select_window_strict
        app = args.get("app")
        title = args.get("title")
        window_id = args.get("window_id")
        if not app and not title and not window_id:
            return None
        self.args_app, self.args_title, self.args_window_id = app, title, window_id
        return select_window_strict(app, title, window_id,
                                    session_window=self.registry.last_window())


# ---------------------------------------------------------------------------
# run_tool：统一入口
# ---------------------------------------------------------------------------

def run_tool(name: str, args: dict | None = None, *, config_file: str | None = None,
             session_id: str | None = None, dry_run: bool = False, timeout_ms: int | None = None,
             env: dict | None = None, cancel: threading.Event | None = None,
             return_image: bool = False) -> dict:
    """执行工具并返回统一 envelope。适配器把 CLI 退出码/MCP 结果都基于此。"""
    args = dict(args or {})
    token = f"{name}:{id(args)}:{time.monotonic_ns()}"
    if cancel is None:
        cancel = register_cancel(token)
    ctx = None
    try:
        import re as _re
        session_id = session_id or str(args.get("session") or "default")
        if not _re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", session_id):
            raise err("INVALID_PARAMS", f"会话 id 只允许字母/数字/下划线/连字符（≤64 字符），得到 {session_id!r}")
        cfg = load_config(file=config_file, env=env)
        ctx = Context(cfg, session_id=session_id,
                      dry_run=dry_run or bool(args.get("dry_run")), cancel=cancel, env=env,
                      run_timeout_ms=timeout_ms)
        handler = _HANDLERS.get(name)
        if handler is None:
            raise err("INVALID_PARAMS", f"未知工具: {name}（可用: {', '.join(sorted(_HANDLERS))}）")
        result = handler(ctx, args, return_image=return_image)
        inner_failed: JevError | None = result.get("__failed") if isinstance(result, dict) else None
        if inner_failed is not None:
            return failed(inner_failed, result=result.get("result"), steps=result.get("steps"),
                          metrics=ctx.metrics.to_dict(), evidence=_evidence(ctx, result))
        return envelope("done", result=result.get("result"), steps=result.get("steps"),
                        evidence=_evidence(ctx, result), metrics=ctx.metrics.to_dict())
    except CancelledSignal:
        return cancelled(metrics=ctx.metrics.to_dict() if ctx else None,
                         evidence=_evidence(ctx, None))
    except JevError as e:
        # 取消优先于错误
        if cancel.is_set():
            return cancelled(metrics=ctx.metrics.to_dict() if ctx else None)
        if ctx is not None:
            ctx.ledger.record(tool=name, action="error", outcome=e.code, session=session_id or "default")
        return failed(e, metrics=ctx.metrics.to_dict() if ctx else None,
                      evidence=_evidence(ctx, None))
    except Exception as e:  # noqa: BLE001 - 适配器需要的是 envelope，不是堆栈
        print(f"[jev-desktop] INTERNAL_ERROR: {traceback.format_exc()}", file=sys.stderr)
        return failed(err("INTERNAL_ERROR", f"内部错误: {format_internal_error(e)}"),
                      metrics=ctx.metrics.to_dict() if ctx else None)
    finally:
        _release_cancel(token)


def _evidence(ctx: Context | None, result) -> dict:
    ev: dict = {"snapshots": [], "artifacts": []}
    if ctx is None:
        return ev
    ev["snapshots"] = list(ctx.registry.data.get("snapshots", {}).keys())[-8:]
    if isinstance(result, dict):
        for source in (result, result.get("result")):
            if isinstance(source, dict) and isinstance(source.get("artifacts"), list):
                ev["artifacts"].extend(a for a in source["artifacts"] if isinstance(a, str))
            if isinstance(source, dict) and source.get("image"):
                ev["artifacts"].append(source["image"])
        ev["artifacts"] = list(dict.fromkeys(ev["artifacts"]))[-16:]
    return ev


# ---------------------------------------------------------------------------
# 各工具实现（返回 {"result": ..., "steps": [...]?}）
# ---------------------------------------------------------------------------

def _t_windows(ctx: Context, args: dict, *, return_image: bool = False) -> dict:
    wins = [w.to_dict() for w in winapi.list_top_windows()]
    return {"result": {"windows": wins, "count": len(wins),
                       "hint": "选窗口用 title 子串或 window_id；app 可用进程名/pid/标题子串"}}


def _t_snapshot(ctx: Context, args: dict, *, return_image: bool = False) -> dict:
    from .observe import take_snapshot
    from .targeting import window_candidates
    win = ctx.pick_window(args)
    if win is None:
        hwnd = ctx.resolve_default_window()
        if not hwnd:
            fg = winapi.user32.GetForegroundWindow()
            if fg and winapi.is_window(fg) and winapi.window_title(fg):
                win = ctx.window_info(fg)
            else:
                cands = window_candidates()
                raise err("APP_NOT_FOUND",
                          "未指定目标窗口；请传 app/title/window_id（可用窗口见 desktop_windows）",
                          details={"candidates": [w.to_dict() for w in cands[:10]]})
        else:
            win = ctx.window_info(hwnd)
    snap = take_snapshot(ctx, win["hwnd"] if isinstance(win, dict) else win.hwnd, win,
                         level=args.get("level"), root_ref=args.get("root"),
                         depth=args.get("depth"), max_elements=args.get("max_elements"),
                         save_artifact=bool(args.get("save_artifact")))
    ctx.ledger.record(tool="desktop_snapshot", action="snapshot",
                      target=f'{win["title"][:80] if isinstance(win, dict) else win.title[:80]} '
                             f'hwnd={win["hwnd"] if isinstance(win, dict) else win.hwnd}',
                      outcome="ok", session=ctx.session_id)
    out = snap.to_dict(include_refs=True)
    out["image"] = snap.image_path
    out["tokenEstimate"] = _tok(snap.text)
    return {"result": out}


def _tok(text: str) -> int:
    from .observe.model import estimate_tokens
    return estimate_tokens(text)


def _t_act(ctx: Context, args: dict, *, return_image: bool = False) -> dict:
    from .act import perform as perform_action
    from .steps import ACTIONS
    from .targeting import resolve_target, validate_target_spec
    action = str(args.get("action", "")).strip()
    if not action:
        raise err("INVALID_PARAMS", "缺少 action 参数")
    if action not in ACTIONS:
        raise err("INVALID_PARAMS", f"未知 action: {action}（白名单: {sorted(ACTIONS)}）")
    if action == "launch":
        # launch 的目标窗口尚不存在；title 参数作为新窗口匹配提示
        ctx.args_app, ctx.args_title, ctx.args_window_id = args.get("app"), args.get("title"), args.get("window_id")
        win = None
    else:
        win = ctx.pick_window(args)
    spec = validate_target_spec(args.get("target"))
    value = args.get("value")
    if value is not None:
        value = str(value)
    target = resolve_target(ctx, spec, window_hwnd=win.hwnd if win else None)
    if ctx.dry_run:
        return {"result": {"dryRun": True, "action": action, "target": target.describe(),
                           "via": target.via, "point": list(target.point) if target.point else None,
                           "note": "dry-run：只解析校验目标，未执行"}}
    t0 = time.monotonic()
    out = perform_action(ctx, action, target, value=value, scope_hwnd=win.hwnd if win else None)
    dur = int((time.monotonic() - t0) * 1000)
    ctx.metrics.actions += 1
    ctx.ledger.record(tool="desktop_act", action=action, target=target.describe(), value=value,
                      outcome="ok", duration_ms=dur, session=ctx.session_id)
    out["action"] = action
    out["target"] = target.describe()
    out["durationMs"] = dur
    return {"result": out}


def _t_execute(ctx: Context, args: dict, *, return_image: bool = False) -> dict:
    from .executor import ExecuteEngine
    from .steps import validate_steps
    from .errors import JevError
    raw_steps = args.get("steps")
    if raw_steps is None:
        raise err("INVALID_PARAMS", "缺少 steps 参数（FlowStep 数组；CLI 可用 --file 传入 JSON）")
    if isinstance(raw_steps, str):
        try:
            import json as _json
            raw_steps = _json.loads(raw_steps)
        except ValueError as e:
            raise err("INVALID_PARAMS", f"steps JSON 解析失败: {e}")
    if not isinstance(raw_steps, list):
        raise err("INVALID_PARAMS", "steps 必须是数组")
    try:
        win = ctx.pick_window(args)
    except JevError as e:
        # 目标窗口可能由步骤内的 launch 动作创建
        if e.code == "APP_NOT_FOUND" and any(isinstance(s, dict) and s.get("act") == "launch" for s in raw_steps):
            win = None
        else:
            raise
    values = args.get("values") or {}
    if not isinstance(values, dict):
        raise err("INVALID_PARAMS", "values 必须是对象")
    steps = validate_steps(raw_steps, variables=values)
    if ctx.dry_run:
        # dry-run：解析全部步骤的目标但不执行
        from .targeting import resolve_target
        preview = []
        for s in steps:
            if s["kind"] == "action" and s.get("target", {}).get("kind") != "none":
                try:
                    t = resolve_target(ctx, s["target"], window_hwnd=win.hwnd if win else None)
                    preview.append({"id": s["id"], "act": s["act"], "resolved": t.describe(), "via": t.via})
                except JevError as e:
                    preview.append({"id": s["id"], "act": s["act"], "error": e.to_dict()})
            else:
                preview.append({"id": s["id"], "kind": s["kind"]})
        return {"result": {"dryRun": True, "steps": preview,
                           "note": "dry-run：目标解析预览，未执行任何动作"}}
    engine = ExecuteEngine(ctx)
    outcome = engine.run(steps=steps, values=values, stop_on_error=bool(args.get("stop_on_error", True)),
                         budget=ctx.budget, window=win)
    results = outcome.get("results", [])
    any_fail = outcome.get("failed") or any(not r.get("ok") for r in results)
    if any_fail:
        e: JevError = outcome.get("error") or err("ASSERT_FAILED", "存在未通过的步骤（stop_on_error=false 已继续执行后续步骤）",
                                                  details={"failedSteps": [r.get("id") for r in results if not r.get("ok")]})
        return {"result": {"steps": results, "variables": outcome["variables"]},
                "steps": results,
                "__failed": e}
    return {"result": {"steps": results, "variables": {k: v for k, v in outcome["variables"].items()
                                                                 if not k.startswith("_")},
                       "artifacts": outcome["artifacts"]},
            "steps": results}


def _t_run(ctx: Context, args: dict, *, return_image: bool = False) -> dict:
    from .runner import RunEngine
    from .planner import planner_configured, planner_unconfigured_error
    goal = str(args.get("goal", "")).strip()
    if not goal:
        raise err("INVALID_PARAMS", "run 需要 goal（一句话自然语言目标）")
    if ctx.dry_run:
        raise err("INVALID_PARAMS",
                  "run 模式不支持 dry-run（规划以真实执行为前提）；如需只解析不执行，请改用 desktop_execute + dry_run")
    if not planner_configured(ctx.cfg, env=ctx.env):
        raise planner_unconfigured_error(ctx.cfg)
    criteria = args.get("success_criteria") or []
    if isinstance(criteria, str):
        criteria = [criteria]
    values = args.get("values") or {}
    win = ctx.pick_window(args)
    engine = RunEngine(ctx)
    outcome = engine.run(goal=goal, criteria=criteria, values=values, window=win,
                         budget=ctx.budget, session_window=ctx.registry.last_window())
    ctx.ledger.record(tool="desktop_run", action="run", target=goal[:120], outcome="ok",
                      session=ctx.session_id)
    return {"result": {"goal": goal, "verified": True, "rounds": outcome["rounds"],
                       "probabilities": outcome.get("probabilities", {}),
                       "criteriaNote": outcome.get("criteriaNote", ""),
                       "analysis": outcome.get("analysis", ""),
                       "roundSummaries": outcome.get("recent", []),
                       "note": "目标已达成并通过 Jev 校验；动作账本见 logs/actions.jsonl"},
            "artifacts": outcome.get("artifacts", [])}


def _t_screenshot(ctx: Context, args: dict, *, return_image: bool = False) -> dict:
    from .observe import screenshot as shot
    full = bool(args.get("full_screen"))
    rect = None
    target_desc = "整屏"
    hwnd = None
    if not full:
        win = ctx.pick_window(args)
        if win is None:
            hwnd = ctx.resolve_default_window() or winapi.user32.GetForegroundWindow()
            if hwnd and winapi.is_window(hwnd):
                win = ctx.window_info(hwnd)
        if win is None:
            raise err("APP_NOT_FOUND", "未指定目标窗口且无法确定前台窗口；可 full_screen=true 截整屏")
        hwnd = win["hwnd"] if isinstance(win, dict) else win.hwnd
        if winapi.ensure_restored(hwnd):
            pass  # 最小化窗口先还原，否则截到的是占位矩形
        rect = winapi.window_rect(hwnd)
        target_desc = f"{winapi.window_title(hwnd)[:60]} hwnd={hwnd}"
    screen = shot.grab_rect(ctx.worker, rect)
    path = ctx.worker.call(lambda: shot.save_artifact(ctx.artifacts_dir_cached, screen, "shot"),
                           15.0, "保存截图")
    ctx.ledger.record(tool="desktop_screenshot", action="screenshot", target=target_desc,
                      outcome="ok", session=ctx.session_id)
    out = {"path": path, "width": screen.size[0], "height": screen.size[1], "image": path}
    import base64
    if return_image:
        out["imageBase64"] = base64.b64encode(shot.to_png_bytes(screen)).decode("ascii")
    return {"result": out}


def _t_clipboard(ctx: Context, args: dict, *, return_image: bool = False) -> dict:
    op = str(args.get("op", "")).strip().lower()
    if op == "get":
        text = winapi.clipboard_get()
        ctx.ledger.record(tool="desktop_clipboard", action="get", outcome="ok",
                          value=f"<{len(text)} 字符>", session=ctx.session_id)
        return {"result": {"op": "get", "text": text, "length": len(text)}}
    if op == "set":
        value = args.get("value")
        if value is None:
            raise err("INVALID_PARAMS", "clipboard set 需要 value")
        winapi.clipboard_set(str(value))
        ctx.ledger.record(tool="desktop_clipboard", action="set", outcome="ok",
                          value=f"<{len(str(value))} 字符>", session=ctx.session_id)
        return {"result": {"op": "set", "length": len(str(value))}}
    if op == "clear":
        winapi.clipboard_clear()
        ctx.ledger.record(tool="desktop_clipboard", action="clear", outcome="ok", session=ctx.session_id)
        return {"result": {"op": "clear"}}
    raise err("INVALID_PARAMS", f"clipboard op 只支持 get/set/clear，得到 {op!r}")


def _t_doctor(ctx: Context, args: dict, *, return_image: bool = False) -> dict:
    from .doctor import run_doctor
    report = run_doctor(ctx, with_network=bool(args.get("with_network")))
    return {"result": report}


_HANDLERS = {
    "desktop_doctor": _t_doctor,
    "desktop_windows": _t_windows,
    "desktop_snapshot": _t_snapshot,
    "desktop_act": _t_act,
    "desktop_execute": _t_execute,
    "desktop_run": _t_run,
    "desktop_screenshot": _t_screenshot,
    "desktop_clipboard": _t_clipboard,
}
