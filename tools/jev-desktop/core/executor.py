"""execute 引擎（DESIGN §8 / ADR-05）：外部步骤顺序执行，确定性动作零模型调用。

- goal 步骤是 execute 内唯一的语义形态（Jev 局部循环：观察→选择→动作→校验）；
- 预算贯穿；动作账本（仅观测）；--dry-run 只解析不执行；
- expect 后置条件在动作后以 wait+轮询验证。
"""

import time

from . import winapi
from .act import perform as perform_action
from .errors import CancelledSignal, JevError, err
from .envelope import Budget, check_cancel
from .observe import take_snapshot
from .observe import ocr as ocr_mod
from .targeting import resolve_target


class ExecuteEngine:
    def __init__(self, ctx):
        self.ctx = ctx

    # ------------------------------------------------------------------

    def run(self, *, steps: list[dict], values: dict | None = None, stop_on_error: bool = True,
            budget: Budget, window: "winapi.WindowInfo | None") -> dict:
        ctx = self.ctx
        variables: dict = {str(k): str(v) for k, v in (values or {}).items()}
        results: list[dict] = []
        screenshots: list[str] = []

        for i, raw in enumerate(steps):
            check_cancel(ctx.cancel)
            budget.check_deadline("execute")
            budget.check_step(len(results))
            try:
                step = raw if isinstance(raw, dict) and raw.get("_normalized") else raw
                step = self._normalize(step, i, variables)
            except JevError as e:
                results.append({"id": f"s{i + 1}", "kind": "invalid", "ok": False, "error": e.to_dict()})
                return self._finish(results, variables, screenshots, failed=True, error=e)
            t0 = time.monotonic()
            try:
                result = self._run_step(step, variables, budget, window, screenshots)
                ok, detail = result.get("ok", True), result
            except CancelledSignal:
                raise
            except JevError as e:
                dur = int((time.monotonic() - t0) * 1000)
                results.append({"id": step["id"], "kind": step["kind"], "act": step.get("act"),
                                "ok": False, "error": e.to_dict(), "durationMs": dur})
                self._ledger(step, target_desc(step, window), value_desc(step), "error", dur)
                if stop_on_error:
                    return self._finish(results, variables, screenshots, failed=True, error=e)
                continue
            dur = int((time.monotonic() - t0) * 1000)
            ctx.metrics.steps += 1
            entry = {"id": step["id"], "kind": step["kind"], "act": step.get("act"),
                     "ok": ok, "durationMs": dur}
            for k in ("used", "detail", "ref", "path", "value", "note", "state", "length", "changed"):
                if isinstance(detail, dict) and detail.get(k) is not None and k not in entry:
                    entry[k] = detail[k]
            if isinstance(detail, dict) and detail.get("summary"):
                entry["target"] = detail["summary"]
            results.append(entry)
            self._ledger(step, target_desc(step, window), value_desc(step),
                         "ok" if ok else "assert_failed", dur)
            if not ok and stop_on_error:
                return self._finish(results, variables, screenshots, failed=True,
                                    error=err("ASSERT_FAILED", f"步骤 {step['id']} 校验未通过（expect/assert）",
                                              details={"step": entry}))
        return self._finish(results, variables, screenshots)

    # ------------------------------------------------------------------

    def _normalize(self, raw: dict, i: int, variables: dict) -> dict:
        from .steps import validate_step
        return validate_step(raw, where=f"steps[{i}]", index=i, variables=variables)

    def _run_step(self, step: dict, variables: dict, budget: Budget, window, screenshots: list) -> dict:
        ctx = self.ctx
        kind = step["kind"]
        if kind == "action":
            return self._run_action(step, variables, window, budget)
        if kind == "wait":
            return self._run_wait(step, variables, window, budget)
        if kind == "screenshot":
            from .observe import screenshot as shot
            rect = window.rect if window else None
            path, size = shot.capture_to_file(ctx.worker, ctx.artifacts_dir_cached, rect, prefix="step")
            screenshots.append(path)
            var = step.get("saveAs")
            if var:
                variables[str(var)] = path
            variables.setdefault("last_screenshot", path)
            return {"ok": True, "path": path}
        if kind == "extract":
            return self._run_extract(step, variables, window)
        if kind == "assert":
            return self._run_assert(step, variables, window)
        if kind == "goal":
            return self._run_goal(step, variables, window, budget)
        raise err("INVALID_STEP", f"未知步骤 kind: {kind}")

    # -- action ---------------------------------------------------------

    def _run_action(self, step: dict, variables: dict, window, budget: Budget) -> dict:
        ctx = self.ctx
        act = step["act"]
        spec = step.get("target") or {"kind": "none"}
        value = step.get("value")
        target = resolve_target(ctx, spec, window_hwnd=window.hwnd if window else None)
        if ctx.dry_run:
            return {"ok": True, "dryRun": True, "summary": target.describe(), "via": target.via}
        window2 = window
        if target.hwnd and (window is None or window.hwnd != target.hwnd):
            try:
                window2 = winapi.WindowInfo(target.hwnd, winapi.window_title(target.hwnd), target.pid or 0,
                                            "", target.rect or (0, 0, 0, 0), "", False, False)
            except Exception:
                window2 = window
        out = perform_action(ctx, act, target, value=value,
                             scope_hwnd=window.hwnd if window else None)
        ctx.metrics.actions += 1
        # ref 失效后由 Actor/上层抛 JevError
        if step.get("expect"):
            w = window2 or window
            self._check_expect(step["expect"], variables, w, budget)
        out.setdefault("ok", True)
        out["summary"] = target.describe()
        return out

    # -- wait -----------------------------------------------------------

    def _run_wait(self, step: dict, variables: dict, window, budget: Budget) -> dict:
        ctx = self.ctx
        mode = step["mode"]
        timeout_ms = step.get("timeoutMs") or budget.wait_max_ms
        timeout_ms = min(int(timeout_ms), budget.wait_max_ms)
        deadline = time.monotonic() + timeout_ms / 1000

        def pred() -> bool:
            if mode == "time":
                return True
            if mode == "element":
                try:
                    resolve_target(ctx, step["target"], window_hwnd=window.hwnd if window else None,
                                   allow_jev=False)
                    return True
                except JevError:
                    return False
            if mode == "text":
                return self._text_present(step.get("text", ""), window)

        if mode == "time":
            ms = min(int(step.get("ms", 0)), timeout_ms)
            end = time.monotonic() + ms / 1000
            while time.monotonic() < end:
                check_cancel(ctx.cancel)
                if budget.remaining_ms() <= 0:
                    raise err("BUDGET_EXCEEDED", "wait 期间超出 runTimeoutMs 预算")
                time.sleep(0.05)
            return {"ok": True, "waitedMs": ms}
        while time.monotonic() < deadline:
            check_cancel(ctx.cancel)
            if budget.remaining_ms() <= 0:
                raise err("BUDGET_EXCEEDED", "wait 期间超出 runTimeoutMs 预算")
            if pred():
                return {"ok": True, "waitedMs": int((time.monotonic() - (deadline - timeout_ms / 1000)) * 1000)}
            time.sleep(0.15)
        raise err("TIMEOUT", f"等待超时（{timeout_ms}ms）：mode={mode}",
                  details={"mode": mode, "text": step.get("text"), "target": step.get("target")})

    # -- extract / assert -------------------------------------------------

    def _run_extract(self, step: dict, variables: dict, window) -> dict:
        ctx = self.ctx
        target = resolve_target(ctx, step["target"], window_hwnd=window.hwnd if window else None,
                                allow_jev=False)
        fields = step["fields"]
        out: dict = {}
        if target.kind == "uia" and target.element is not None:
            uia = ctx.worker.import_uia()
            from .act import uia_actions

            def _read():
                data = {}
                if "text" in fields:
                    data["text"] = target.element.Name or ""
                if "value" in fields:
                    data["value"] = uia_actions.get_value(target.element, uia)
                if "text" in fields and not data["text"]:
                    # WinForms Edit 等控件的 Name 常为空，内容在 ValuePattern 里
                    data["text"] = uia_actions.get_value(target.element, uia)
                if "rect" in fields:
                    data["rect"] = list(uia_actions.element_rect(target.element))
                if "enabled" in fields:
                    try:
                        data["enabled"] = bool(target.element.IsEnabled)
                    except Exception:
                        data["enabled"] = None
                if "checked" in fields:
                    data["checked"] = uia_actions.toggle_state_of(target.element, uia)
                return data

            out = ctx.worker.call(_read, 10.0, "extract 读取元素")
        elif target.kind == "point":
            out = {"point": list(target.point or [])}
            if getattr(target, "text", None):
                out["text"] = target.text
        # saveAs 取第一个请求字段的值（用户字段顺序即意图优先级）
        primary = fields[0]
        variables[step["saveAs"]] = out.get(primary, "") if primary in out else ""
        return {"ok": True, "extracted": {k: (v if not isinstance(v, str) else v[:120]) for k, v in out.items()},
                "savedAs": step["saveAs"]}

    def _run_assert(self, step: dict, variables: dict, window) -> dict:
        op = step["op"]
        if op == "var_equals":
            left = str(variables.get(step["name"], ""))
            if left != str(step.get("value", "")):
                return {"ok": False, "detail": f"变量 {step['name']}={left!r} != {step.get('value')!r}"}
            return {"ok": True}
        if op == "var_contains":
            left = str(variables.get(step["name"], ""))
            if str(step.get("value", "")) not in left:
                return {"ok": False, "detail": f"变量 {step['name']} 不包含 {step.get('value')!r}"}
            return {"ok": True}
        if op == "var_exists":
            if step["name"] not in variables:
                return {"ok": False, "detail": f"变量 {step['name']} 未定义"}
            return {"ok": True}
        if op == "element_exists":
            try:
                resolve_target(self.ctx, step["target"], window_hwnd=window.hwnd if window else None,
                               allow_jev=False)
                return {"ok": True}
            except JevError:
                return {"ok": False, "detail": "元素不存在"}
        if op == "element_gone":
            try:
                resolve_target(self.ctx, step["target"], window_hwnd=window.hwnd if window else None,
                               allow_jev=False)
                return {"ok": False, "detail": "元素仍然存在"}
            except JevError:
                return {"ok": True}
        if op == "window_title_contains":
            hwnd = window.hwnd if window else self.ctx.resolve_default_window()
            title = winapi.window_title(hwnd) if hwnd and winapi.is_window(hwnd) else ""
            if str(step.get("value", "")) not in title:
                return {"ok": False, "detail": f"窗口标题 \"{title}\" 不包含 {step.get('value')!r}"}
            return {"ok": True}
        raise err("INVALID_STEP", f"未知断言 {op}")

    # -- expect（动作后置条件）---------------------------------------------

    def _check_expect(self, expects: list[dict], variables: dict, window, budget: Budget) -> None:
        for e in expects:
            timeout_ms = min(e.get("timeoutMs") or budget.wait_max_ms, budget.wait_max_ms)
            deadline = time.monotonic() + timeout_ms / 1000
            kind = e["kind"]
            while True:
                check_cancel(self.ctx.cancel)
                if kind == "element_exists":
                    try:
                        resolve_target(self.ctx, e["target"], window_hwnd=window.hwnd if window else None,
                                       allow_jev=False)
                        break
                    except JevError:
                        pass
                elif kind == "element_gone":
                    try:
                        resolve_target(self.ctx, e["target"], window_hwnd=window.hwnd if window else None,
                                       allow_jev=False)
                    except JevError:
                        break
                elif kind == "text_present":
                    if self._text_present(e["text"], window):
                        break
                elif kind == "window_title_contains":
                    hwnd = window.hwnd if window else self.ctx.resolve_default_window()
                    title = winapi.window_title(hwnd) if hwnd and winapi.is_window(hwnd) else ""
                    if str(e.get("value", "")) in title:
                        break
                if time.monotonic() >= deadline:
                    raise err("TIMEOUT", f"expect 未在 {timeout_ms}ms 内满足: {kind}",
                              details={"expect": {k: v for k, v in e.items() if k != "target"}})
                time.sleep(0.2)

    def _text_present(self, text: str, window) -> bool:
        """文字出现检查：先查 UIA 快照文本（零模型成本），OCR 兜底。"""
        hwnd = window.hwnd if window else self.ctx.resolve_default_window()
        if not hwnd:
            return False
        try:
            win_info = self.ctx.window_info(hwnd)
            snap = take_snapshot(self.ctx, hwnd, win_info, level="uia")
            if text in snap.text:
                return True
        except JevError:
            pass
        try:
            from .observe import screenshot as shot
            rect = winapi.window_rect(hwnd)
            screen = shot.grab_rect(self.ctx.worker, rect)
            png = self.ctx.worker.call(lambda: shot.to_png_bytes(screen), 10.0, "截图")
            blocks = self.ctx.worker.call(lambda: ocr_mod.recognize(png), 20.0, "OCR")
            return any(text in b.text for b in blocks)
        except JevError:
            return False

    # -- goal（Jev 局部循环）------------------------------------------------

    def _run_goal(self, step: dict, variables: dict, window, budget: Budget) -> dict:
        from .goal_loop import goal_loop
        return goal_loop(self.ctx, goal=step["goal"], value=step.get("value"), window=window,
                         budget=budget, expect=step.get("expect"), variables=variables)

    # ------------------------------------------------------------------

    def _ledger(self, step: dict, target: str, value: str | None, outcome: str, dur: int) -> None:
        try:
            self.ctx.ledger.record(tool="desktop_execute", action=step.get("act") or step.get("kind", ""),
                                   target=target, value=value, outcome=outcome, duration_ms=dur,
                                   session=self.ctx.session_id)
        except Exception:
            pass

    def _finish(self, results: list[dict], variables: dict, screenshots: list[str],
                *, failed: bool = False, error: JevError | None = None) -> dict:
        return {"__engine": True, "results": results, "variables": variables,
                "artifacts": screenshots, "failed": failed, "error": error}


def target_desc(step: dict, window) -> str:
    t = step.get("target") or {}
    if isinstance(t, dict):
        return str(t.get("ref") or t.get("target") or t.get("name") or t.get("kind") or "")
    return ""


def value_desc(step: dict) -> str | None:
    v = step.get("value")
    return str(v) if v is not None else None
