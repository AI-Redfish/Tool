"""目标定位（DESIGN §4.3 / §8 / ADR-03）。

- 窗口选择：--app/--title/--window_id；多候选时 execute/snapshot 返回候选列表（AMBIGUOUS_TARGET），
  run/goal 用 Jev Choice 消歧（低置信也返回候选），绝不猜“第一个就是”；
- TargetSpec 解析：ref（活性校验：pid+指纹+矩形，ADR-03）/ uia 选择器 / coords / text（Jev 选择）/ none。
UIA 元素操作全部经 UiaWorker（COM STA）；COM 指针只在 worker 线程内有效，ResolvedTarget.element 仅供 worker 使用。
"""

from dataclasses import dataclass

from . import winapi
from .errors import JevError, err
from .observe import uia_tree
from .observe.model import TextBlock
from .session import REF_DRIFT_PX, parse_ref


@dataclass
class ResolvedTarget:
    kind: str                       # uia | point | window | none
    hwnd: int | None = None
    pid: int | None = None
    element: object | None = None   # UIA Control（仅 worker 线程内有效）
    rect: tuple | None = None
    point: tuple | None = None      # 坐标目标点（绝对物理像素）
    center_point: tuple | None = None
    summary: str = ""
    via: str = ""                   # ref | selector | coords | text | scope
    note: str = ""
    text: str | None = None         # 文字块 ref 携带的原始文本（供 extract）

    def describe(self) -> str:
        if self.summary:
            return self.summary
        return f"{self.kind}@{self.hwnd or '?'}"


# ---------------------------------------------------------------------------
# 窗口选择
# ---------------------------------------------------------------------------

def window_candidates(app: str | None = None, title: str | None = None, window_id: int | None = None) -> list[winapi.WindowInfo]:
    wins = winapi.list_top_windows()
    if window_id:
        return [w for w in wins if w.hwnd == window_id]
    out = wins
    if app:
        app_l = app.strip().lower()
        by_pid = app_l.isdigit()
        matched = []
        for w in out:
            if by_pid:
                if w.pid == int(app_l):
                    matched.append(w)
            else:
                proc = (w.process or "").lower().removesuffix(".exe")
                if proc == app_l or proc == app_l.removesuffix(".exe") or app_l in w.title.lower():
                    matched.append(w)
        out = matched
    if title:
        t = title.strip().lower()
        out = [w for w in out if t in w.title.lower()]
    return out


def select_window_strict(app=None, title=None, window_id=None, *, session_window: dict | None = None) -> winapi.WindowInfo:
    """严格窗口选择：零或多个匹配都报错（execute/snapshot 路径）。

    无任何过滤条件时按回退顺序：会话最近窗口（仍存活）→ 前台窗口。
    """
    if not app and not title and not window_id:
        if session_window:
            hwnd = session_window.get("hwnd")
            if hwnd and winapi.is_window(hwnd):
                pid = winapi.window_pid(hwnd)
                rect = winapi.window_rect(hwnd)
                if rect:
                    return winapi.WindowInfo(hwnd, winapi.window_title(hwnd) or session_window.get("title", ""),
                                             pid, session_window.get("process", ""), rect, "", False, False)
        fg = winapi.user32.GetForegroundWindow()
        if fg and winapi.is_window(fg) and winapi.window_title(fg):
            pid = winapi.window_pid(fg)
            rect = winapi.window_rect(fg) or (0, 0, 0, 0)
            return winapi.WindowInfo(fg, winapi.window_title(fg), pid, winapi._process_name(pid), rect,
                                     winapi._window_class_name(fg), True, False)
        raise err("APP_NOT_FOUND", "未指定目标且无法确定前台窗口；请用 app/title/window_id 指定，或先 desktop_windows 查看")
    cands = window_candidates(app, title, window_id)
    if not cands:
        raise err("APP_NOT_FOUND",
                  f"找不到匹配窗口（app={app!r} title={title!r} window_id={window_id!r}）；"
                  "请先 desktop_windows 查看可见窗口，或先用 desktop_act action=launch 启动应用",
                  details={"candidates": [w.to_dict() for w in window_candidates()][:10]})
    if len(cands) > 1:
        raise _ambiguous(cands)
    return cands[0]


def select_window_with_jev(app, title, window_id, jev, *, session_window=None) -> winapi.WindowInfo:
    """run 路径：多候选时用 Jev Choice 消歧；低置信返回 AMBIGUOUS_TARGET。"""
    if not app and not title and not window_id:
        return select_window_strict(None, None, None, session_window=session_window)
    cands = window_candidates(app, title, window_id)
    if not cands:
        raise err("APP_NOT_FOUND", f"找不到匹配窗口（app={app!r} title={title!r} window_id={window_id!r}）")
    if len(cands) == 1:
        return cands[0]
    labels = [f"[{i}] 进程={w.process} 标题=\"{w.title}\" pid={w.pid}" for i, w in enumerate(cands)]
    idx, probs = jev.choice(
        state={"candidates": labels},
        question="哪个窗口是完成目标的正确目标窗口？",
        candidates=labels,
        instructions="根据进程名与标题选择最可能匹配用户目标应用的那个。",
    )
    conf = max(probs.values()) if probs else 0.0
    threshold = 0.7
    if idx is None or conf < threshold:
        raise _ambiguous(cands, note=f"Jev 消歧置信度低（{conf:.2f}<{threshold}）")
    return cands[idx]


def _ambiguous(cands: list[winapi.WindowInfo], note: str | None = None) -> JevError:
    return err("AMBIGUOUS_TARGET",
               (note + "；" if note else "") + f"匹配到 {len(cands)} 个窗口，请用 title/window_id 精确指定：\n" +
               "\n".join(f"  - [{w.hwnd}] 进程={w.process} 标题=\"{w.title}\" pid={w.pid}" for w in cands[:8]),
               details={"candidates": [w.to_dict() for w in cands[:10]]})


# ---------------------------------------------------------------------------
# TargetSpec 解析
# ---------------------------------------------------------------------------

def validate_target_spec(raw, where: str = "target") -> dict:
    """校验并规范化 TargetSpec（不解析）。"""
    if raw is None:
        return {"kind": "none"}
    if isinstance(raw, str):
        # 容错：字符串视为 ref 或语义文本
        if raw.startswith("@"):
            return {"kind": "ref", "ref": raw}
        return {"kind": "text", "target": raw}
    if not isinstance(raw, dict):
        raise err("INVALID_PARAMS", f"{where}: TargetSpec 必须是对象或 ref 字符串")
    kind = raw.get("kind")
    if kind == "ref":
        ref = raw.get("ref")
        parse_ref(str(ref))
        return {"kind": "ref", "ref": str(ref)}
    if kind == "uia":
        out: dict = {"kind": "uia"}
        for k in ("controlType", "name", "automationId", "className"):
            if raw.get(k):
                out[k] = str(raw[k])
        if raw.get("index") is not None:
            try:
                out["index"] = int(raw["index"])
            except (TypeError, ValueError):
                raise err("INVALID_PARAMS", f"{where}.index 必须是整数")
        if not any(out.get(k) for k in ("controlType", "name", "automationId", "className")):
            raise err("INVALID_PARAMS", f"{where}: kind=uia 至少需要 controlType/name/automationId 之一")
        return out
    if kind == "coords":
        try:
            x, y = int(raw["x"]), int(raw["y"])
        except (KeyError, TypeError, ValueError):
            raise err("INVALID_PARAMS", f"{where}: kind=coords 需要整数 x/y")
        return {"kind": "coords", "x": x, "y": y}
    if kind == "text":
        t = raw.get("target") or raw.get("text")
        if not t or not str(t).strip():
            raise err("INVALID_PARAMS", f"{where}: kind=text 需要 target=语义描述")
        return {"kind": "text", "target": str(t).strip()}
    if kind == "none":
        return {"kind": "none"}
    raise err("INVALID_PARAMS", f"{where}: 未知 TargetSpec kind {kind!r}（ref/uia/coords/text/none）")


def resolve_target(ctx, spec: dict, *, window_hwnd: int | None = None, allow_jev: bool = True) -> ResolvedTarget:
    """解析 TargetSpec 为 ResolvedTarget（ref 校验/选择器搜索/Jev 语义选择都在此完成）。"""
    kind = spec.get("kind", "none")
    if kind == "none":
        return ResolvedTarget(kind="none", summary="全局", via="none")
    if kind == "coords":
        return ResolvedTarget(kind="point", point=(spec["x"], spec["y"]), hwnd=window_hwnd,
                              summary=f"坐标({spec['x']},{spec['y']})", via="coords")
    if kind == "ref":
        return resolve_ref(ctx, spec["ref"])
    if kind == "uia":
        return resolve_selector(ctx, spec, window_hwnd)
    if kind == "text":
        return resolve_text(ctx, spec["target"], window_hwnd=window_hwnd, allow_jev=allow_jev)
    raise err("INVALID_PARAMS", f"未知 TargetSpec kind: {kind}")


def resolve_ref(ctx, ref: str) -> ResolvedTarget:
    """ref 解析 + 活性校验（ADR-03）：绝不盲点旧坐标。"""
    ctx.registry.check_ttl(ref)
    info = ctx.registry.lookup(ref)
    if not info:
        raise err("STALE_REF",
                  f"ref {ref} 不在会话中（可能来自其他会话或已过期）；请对目标窗口重新 desktop_snapshot",
                  details={"ref": ref})
    sid = ref[1:].split(":")[0]
    meta = ctx.registry.snapshot_meta(sid) or {}
    win = meta.get("window") or {}
    hwnd = info.get("hwnd") or win.get("hwnd")
    pid = info.get("pid") or win.get("pid")

    if info.get("kind") == "block":
        # 文字块：校验窗口存活 + pid 一致；坐标 = 当前窗口原点 + 相对中心
        if not hwnd or not winapi.is_window(hwnd):
            raise err("STALE_REF", f"ref {ref} 所在窗口已关闭；请重新快照", details={"ref": ref})
        cur_pid = winapi.window_pid(hwnd)
        if pid and cur_pid != pid:
            raise err("STALE_REF", f"ref {ref} 的窗口属主已变（{pid}→{cur_pid}）；请重新快照")
        cur_rect = winapi.window_rect(hwnd)
        if not cur_rect:
            raise err("STALE_REF", f"ref {ref} 的窗口矩形不可得（可能最小化）；请先还原窗口再重试")
        if winapi.ensure_restored(hwnd):
            cur_rect = winapi.window_rect(hwnd) or cur_rect
        rel = info.get("relRect") or [0, 0, 0, 0]
        l, t = cur_rect[0], cur_rect[1]
        cx, cy = info.get("relCenter") or ((rel[0] + rel[2]) // 2, (rel[1] + rel[3]) // 2)
        point = (l + int(cx), t + int(cy))
        return ResolvedTarget(kind="point", hwnd=hwnd, pid=cur_pid, point=point, center_point=point,
                              rect=(l + rel[0], t + rel[1], l + rel[2], t + rel[3]),
                              text=str(info.get("text", "")),
                              summary=f"{ref} \"{str(info.get('text', ''))[:30]}\"", via="ref")

    # UIA 元素 ref
    if not hwnd or not winapi.is_window(hwnd):
        raise err("STALE_REF", f"ref {ref} 所在窗口已关闭；请重新快照", details={"ref": ref})
    cur_pid = winapi.window_pid(hwnd)
    if pid and cur_pid != pid:
        raise err("STALE_REF", f"ref {ref} 的窗口属主已变（pid {pid}→{cur_pid}）；请重新快照")
    uia = ctx.worker.import_uia()
    timeout = max(5.0, ctx.cfg["runtime"]["actTimeoutMs"] / 1000)

    def _do():
        win_ctrl = uia_tree.window_control(uia, hwnd)
        ctrl, n_matches = uia_tree.find_by_fingerprint(
            uia, win_ctrl, info.get("fingerprint", ""), info.get("runtimeId"),
            tuple(info.get("rect") or ()), search_depth=14)
        if ctrl is None:
            return None
        try:
            rect = uia_actions_rect(ctrl)
        except Exception:
            return None
        old = tuple(info.get("rect") or ())
        rid = info.get("runtimeId") or []
        try:
            cur_rid = [int(x) for x in (ctrl.GetRuntimeId() or [])]
        except Exception:
            cur_rid = []
        drift = _drift(old, rect)
        if n_matches == 1 or (rid and cur_rid == rid):
            if drift > REF_DRIFT_PX and not (rid and cur_rid == rid):
                return ("drift", ctrl, rect, drift, n_matches)
            return ("ok", ctrl, rect, drift, n_matches)
        if drift <= REF_DRIFT_PX:
            return ("ok", ctrl, rect, drift, n_matches)
        return ("drift", ctrl, rect, drift, n_matches)

    result = ctx.worker.call(_do, timeout, f"ref 活性校验 {ref}")
    if result is None:
        raise err("STALE_REF",
                  f"ref {ref} 的元素已不存在（指纹重找失败）；请重新 desktop_snapshot 获取新 ref",
                  details={"ref": ref, "fingerprint": info.get("fingerprint")})
    status, element, rect, drift, n_matches = result
    if status == "drift":
        raise err("STALE_REF",
                  f"ref {ref} 校验失败：矩形漂移 {drift}px 超阈值 {REF_DRIFT_PX}px 且不唯一；请重新快照",
                  details={"ref": ref, "driftPx": drift, "matches": n_matches, "newRect": list(rect)})

    center = ((rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2)
    return ResolvedTarget(kind="uia", hwnd=hwnd, pid=cur_pid, element=element, rect=rect,
                          point=center, center_point=center,
                          summary=f"{ref} {info.get('role', '')} \"{str(info.get('name', ''))[:30]}\"", via="ref")


def resolve_selector(ctx, spec: dict, window_hwnd: int | None) -> ResolvedTarget:
    """uia 选择器：在目标窗口子树内按 controlType/name/automationId/className 搜索。"""
    hwnd = window_hwnd or ctx.resolve_default_window()
    if not hwnd:
        raise err("APP_NOT_FOUND", "uia 选择器需要目标窗口（先指定 app/title/window_id）")
    uia = ctx.worker.import_uia()
    index = spec.get("index", 0)
    wanted = {k: spec.get(k) for k in ("controlType", "name", "automationId", "className")}

    def _do():
        win_ctrl = uia_tree.window_control(uia, hwnd)

        def compare(c) -> bool:
            try:
                if wanted["controlType"]:
                    role = uia_tree.short_role(c.ControlTypeName)
                    wt_ = wanted["controlType"]
                    if role.lower() != wt_.lower() and role.lower() != str(wt_).lower().removesuffix("control"):
                        return False
                if wanted["automationId"] and (c.AutomationId or "") != wanted["automationId"]:
                    return False
                if wanted["className"] and (c.ClassName or "") != wanted["className"]:
                    return False
                if wanted["name"]:
                    n = wanted["name"]
                    nm = c.Name or ""
                    if nm != n and n not in nm:  # 精确优先，含子串回退
                        return False
                return True
            except Exception:
                return False

        matches = uia_tree._find_all(uia, win_ctrl, compare, 14)
        return matches

    matches = ctx.worker.call(_do, max(5.0, ctx.cfg["runtime"]["actTimeoutMs"] / 1000), "uia 选择器搜索")
    if not matches:
        raise err("TARGET_NOT_FOUND",
                  f"窗口内找不到控件（{wanted}）；请先 desktop_snapshot 查看结构，或用 ref/text 定位")
    if index >= len(matches):
        raise err("TARGET_NOT_FOUND",
                  f"匹配到 {len(matches)} 个控件，index={index} 越界；请调整 index",
                  details={"matched": len(matches)})

    def _rect(c):
        try:
            r = c.BoundingRectangle
            return (int(r.left), int(r.top), int(r.right), int(r.bottom))
        except Exception:
            return (0, 0, 0, 0)

    element = matches[index]
    rect = ctx.worker.call(lambda: _rect(element), 5.0, "读取元素矩形")
    center = ((rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2)
    role = ctx.worker.call(lambda: uia_tree.short_role(element.ControlTypeName), 5.0, "读取元素类型")
    name = ctx.worker.call(lambda: element.Name or "", 5.0, "读取元素名称")
    return ResolvedTarget(kind="uia", hwnd=hwnd, element=element, rect=rect, point=center, center_point=center,
                          summary=f"选择器 {role} \"{name[:30]}\"(#{index})", via="selector")


def resolve_text(ctx, text: str, *, window_hwnd: int | None = None, allow_jev: bool = True) -> ResolvedTarget:
    """语义目标：快照 → Jev Choice 选元素/文字块 → 定位。"""
    if not allow_jev:
        raise err("PROVIDER_ERROR", "语义目标（kind=text）需要 Jev，但当前上下文禁用了模型调用")
    jev = ctx.jev_required()
    from .observe import take_snapshot
    hwnd = window_hwnd or ctx.resolve_default_window()
    if not hwnd:
        raise err("APP_NOT_FOUND", f"语义目标 \"{text}\" 需要目标窗口（先指定 app/title/window_id）")
    win_info = ctx.window_info(hwnd)
    snap = take_snapshot(ctx, hwnd, win_info)

    candidates, labels = build_candidates(snap)
    if not candidates:
        raise err("TARGET_NOT_FOUND",
                  "快照中没有可选候选（窗口可能不可交互）；可尝试 level=ocr/vlm 观察后用 ref/coords 定位")
    idx, probs = jev.choice(
        state={"goal": text, "window": {"title": win_info.get("title"), "pid": win_info.get("pid")},
               "candidates": labels},
        question=f"哪个候选最匹配语义目标“{text}”？",
        candidates=labels,
        instructions="候选是当前窗口的交互元素或文字块。找不到匹配时选 none。",
    )
    if idx is None:
        raise err("TARGET_NOT_FOUND",
                  f"Jev 判断无候选匹配语义目标 \"{text}\"；请重新快照或调整描述",
                  details={"probability": probs})
    conf = max(probs.values()) if probs else 0.0
    threshold = ctx.cfg["jev"]["confidenceAt"]
    chosen = candidates[idx]
    if conf < threshold:
        raise err("AMBIGUOUS_TARGET",
                  f"语义目标 \"{text}\" 匹配置信度低（{conf:.2f}<{threshold}）；请改用 ref 精确定位",
                  details={"top": probs, "chosenLabel": chosen[1]})
    if chosen[0] == "uia":
        resolved = resolve_ref(ctx, chosen[2].ref)
        resolved.note = f"Jev 选择（置信 {conf:.2f}）"
        return resolved
    block: TextBlock = chosen[2]
    cur = winapi.window_rect(hwnd) or (0, 0, 0, 0)
    pt = (cur[0] + block.rel_center[0], cur[1] + block.rel_center[1])
    return ResolvedTarget(kind="point", hwnd=hwnd, point=pt, center_point=pt,
                          summary=f"文字块 \"{block.text[:30]}\"", via="text",
                          note=f"Jev 选择（置信 {conf:.2f}）")


def build_candidates(snap):
    """快照 → Jev Choice 候选（≤200，DESIGN §6）。返回 [(type, label, payload), ...]。"""
    out: list[tuple[str, str, object]] = []
    labels: list[str] = []
    if snap.level == "uia":
        elems = [e for e in snap.elements if e.interactive and not e.offscreen]
        if not elems:
            elems = [e for e in snap.elements if e.interactive]
        for e in elems[:200]:
            label = f"[e] {e.role} \"{e.name[:40]}\""
            if e.automation_id:
                label += f" aid={e.automation_id[:30]}"
            if e.value:
                label += f" val=\"{e.value[:20]}\""
            out.append(("uia", label, e))
            labels.append(label)
    else:
        for b in snap.blocks[:200]:
            label = f"[b] \"{b.text[:60]}\" ({b.confidence:.2f})"
            out.append(("block", label, b))
            labels.append(label)
    return out, labels


# ---------------------------------------------------------------------------

def uia_actions_rect(ctrl) -> tuple[int, int, int, int]:
    from .act import uia_actions
    return uia_actions.element_rect(ctrl)


def _drift(a: tuple | None, b: tuple | None) -> int:
    if not a or not b:
        return 10**9
    ax, ay = (a[0] + a[2]) / 2, (a[1] + a[3]) / 2
    bx, by = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return int(((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5)
