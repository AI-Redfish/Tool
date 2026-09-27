"""动作通道统一入口（DESIGN §5）。

ResolvedTarget 由 targeting 产出；本模块只执行动作：
- UIA 语义动作优先（不抢焦点）；Pattern 不可用时按动作类型决定坐标兜底；
- 坐标动作先把窗口置前台（SendInput 绝对坐标，期间请勿占用鼠标键盘）。
"""

import time

from .. import winapi
from ..errors import JevError, err
from . import mouse_kb, uia_actions, winmgmt
from ..observe import uia_tree

GLOBAL_ACTIONS = {"launch", "close", "minimize", "maximize", "restore", "move", "resize",
                  "press", "clipboard_get", "clipboard_set"}
SCROLL_DIRS = ("up", "down", "left", "right")


def perform(ctx, action: str, target, *, value: str | None = None,
            scope_hwnd: int | None = None) -> dict:
    """执行单动作。target: ResolvedTarget | None。scope_hwnd 为调用方解析到的目标窗口。

    抛出的 JevError 由上层转 envelope；账本由调用方记。
    """
    act = (action or "").strip()
    if not act:
        raise err("INVALID_PARAMS", "action 不能为空")

    # ---- 全局动作（无元素目标）----
    if act == "launch":
        cmd = winmgmt.resolve_launch_cmd(value or (target.summary if target else ""))
        wait_ms = min(ctx.cfg["runtime"]["waitMaxMs"], 10000)
        out = winmgmt.launch(cmd, wait_ms=wait_ms, title_hint=getattr(ctx, "args_title", None))
        out["used"] = "process"
        if out.get("hwnd"):
            ctx.registry.set_last_window_hwnd(out["hwnd"])
        return out
    if act == "clipboard_get":
        return {"used": "clipboard", "text": winapi.clipboard_get()}
    if act == "clipboard_set":
        winapi.clipboard_set(str(value if value is not None else ""))
        return {"used": "clipboard", "length": len(value or "")}

    if act in ("close", "minimize", "maximize", "restore", "move", "resize", "focus"):
        return _window_action(ctx, act, target, value, scope_hwnd=scope_hwnd)

    if act == "press":
        if not value:
            raise err("INVALID_PARAMS", "press 需要 value=键组合，如 ctrl+s / enter / alt+f4")
        if target is not None and target.kind != "none":
            hwnd = target.hwnd
            used = mouse_kb.press_combo(value, hwnd=hwnd)
            return {"used": used, "keys": value}
        hwnd = scope_hwnd or ctx.resolve_default_window()
        if not hwnd:
            raise err("APP_NOT_FOUND", "press 无目标时需要目标窗口（app/title/window_id）")
        winmgmt.focus_window(hwnd)
        winapi.key_combo(value)
        return {"used": "sendinput_key", "keys": value, "note": "已发送到当前焦点"}
    if act == "type":
        if value is None:
            raise err("INVALID_PARAMS", "type 需要 value=要输入的文本")
        if target is not None and target.kind != "none":
            return _uia_action(ctx, act, target, value)
        hwnd = scope_hwnd or ctx.resolve_default_window()
        if not hwnd:
            raise err("APP_NOT_FOUND", "type 无目标时需要目标窗口（app/title/window_id）")
        winmgmt.focus_window(hwnd)
        used, n = mouse_kb.type_text(str(value), hwnd=hwnd)
        return {"used": used, "length": n, "note": "已输入到当前焦点控件"}
    if act == "scroll":
        if target is not None and target.kind != "none":
            return _uia_action(ctx, act, target, value)
        hwnd = scope_hwnd or ctx.resolve_default_window()
        if not hwnd:
            raise err("APP_NOT_FOUND", "scroll 无目标时需要目标窗口（app/title/window_id）")
        direction, times = _parse_scroll(value)
        rect = winapi.window_rect(hwnd) or (0, 0, 0, 0)
        cx, cy = (rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2
        return {"used": mouse_kb.wheel(direction, times, x=cx, y=cy, hwnd=hwnd),
                "direction": direction, "times": times}

    # ---- 元素动作 ----
    if target is None:
        raise err("INVALID_PARAMS", f"动作 {act} 需要 target（ref/uia/coords/text），全局动作无需 target 的有: "
                                    f"{'、'.join(sorted(GLOBAL_ACTIONS))}")

    if target.kind == "uia":
        return _uia_action(ctx, act, target, value)
    if target.kind == "point":
        return _point_action(act, target, value)
    raise err("INVALID_PARAMS", f"动作 {act} 不支持目标类型 {target.kind}")


def _hwnd_of(target) -> int | None:
    return target.hwnd if target else None


def _window_action(ctx, act: str, target, value, *, scope_hwnd: int | None = None) -> dict:
    hwnd = (target.hwnd if target and target.hwnd else None) or scope_hwnd or ctx.resolve_default_window()
    if not hwnd:
        raise err("APP_NOT_FOUND", f"窗口动作 {act} 需要目标窗口（app/title/window_id 或 ref）")
    if act == "focus":
        winmgmt.focus_window(hwnd)
        return {"used": "win32", "hwnd": hwnd}
    if act == "close":
        winmgmt.close_window(hwnd)
        return {"used": "win32", "hwnd": hwnd}
    if act == "minimize":
        winapi.show_window(hwnd, winapi.SW_MINIMIZE)
        return {"used": "win32", "hwnd": hwnd}
    if act == "maximize":
        winapi.show_window(hwnd, winapi.SW_MAXIMIZE)
        return {"used": "win32", "hwnd": hwnd}
    if act == "restore":
        winapi.show_window(hwnd, winapi.SW_RESTORE)
        return {"used": "win32", "hwnd": hwnd}
    if act == "move":
        x, y = _parse_xy(value)
        winmgmt.move_window(hwnd, x, y)
        return {"used": "win32", "hwnd": hwnd, "moved": [x, y]}
    if act == "resize":
        w, h = _parse_xy(value)
        winmgmt.resize_window(hwnd, w, h)
        return {"used": "win32", "hwnd": hwnd, "resized": [w, h]}
    raise err("INVALID_PARAMS", f"未知窗口动作 {act}")


def _parse_xy(value: str | None) -> tuple[int, int]:
    if not value or "," not in value:
        raise err("INVALID_PARAMS", "需要 value=\"x,y\" 形式（如 100,200）")
    try:
        a, b = value.split(",", 1)
        return int(a.strip()), int(b.strip())
    except ValueError:
        raise err("INVALID_PARAMS", f"value=\"x,y\" 解析失败: {value!r}")


def _uia_action(ctx, act: str, target, value) -> dict:
    """UIA 语义动作；Pattern 不可用时按动作语义决定坐标/键盘兜底。"""
    uia = ctx.worker.import_uia()
    element = target.element
    if element is None:
        raise err("STALE_REF", "目标元素未解析（内部错误）：请重新快照")
    hwnd = target.hwnd

    def _run():
        if act == "invoke":
            used = uia_actions.do_invoke(element, uia)
            if used:
                return {"used": used}
            return _coordinate_fallback(ctx, target, "invoke")
        if act == "click":
            used = uia_actions.do_invoke(element, uia)
            if used:
                return {"used": used, "note": "click 经 InvokePattern 语义执行"}
            return _coordinate_fallback(ctx, target, "click")
        if act == "double_click":
            return _coordinate_fallback(ctx, target, "double_click")
        if act == "right_click":
            return _coordinate_fallback(ctx, target, "right_click")
        if act == "hover":
            return _coordinate_fallback(ctx, target, "hover")
        if act == "set_value":
            if value is None:
                raise err("INVALID_PARAMS", "set_value 需要 value=要设置的文本")
            used = uia_actions.do_set_value(element, uia, str(value))
            if used:
                return {"used": used}
            # 兜底：焦点 + 全选 + 输入（SendInput 需要前台窗口）
            if uia_actions.do_focus(element, uia):
                mouse_kb.ensure_foreground(hwnd)
                time.sleep(0.05)
                try:
                    winapi.key_combo("ctrl+a")
                except JevError:
                    pass
                used2, n = mouse_kb.type_text(str(value), clipboard_fallback=True)
                return {"used": f"focus+type({used2})", "length": n,
                        "note": "控件不支持 ValuePattern，已用焦点+键盘输入兜底"}
            raise err("TARGET_NOT_FOUND", "目标控件不可聚焦且不支持 ValuePattern，无法设置值")
        if act == "type":
            if value is None:
                raise err("INVALID_PARAMS", "type 需要 value=要输入的文本")
            if not uia_actions.do_focus(element, uia):
                pt = uia_actions.element_clickable_point(element) or uia_actions.element_center(element)
                mouse_kb.click_at(pt[0], pt[1], hwnd=hwnd)
            # SendInput 只作用于前台窗口：键盘输入前确保目标窗口在前台
            mouse_kb.ensure_foreground(hwnd)
            used, n = mouse_kb.type_text(str(value), hwnd=None)
            return {"used": used, "length": n}
        if act in ("toggle", "check", "uncheck"):
            if act == "toggle":
                used = uia_actions.do_toggle(element, uia)
                if not used:
                    return _coordinate_fallback(ctx, target, "click")
                return {"used": used}
            want = 1 if act == "check" else 0
            changed, state = uia_actions.do_check(element, uia, want)
            return {"used": "uia_toggle", "changed": changed, "state": state}
        if act == "select":
            win_ctrl = None
            if hwnd:
                try:
                    win_ctrl = uia_tree.window_control(uia, hwnd)
                except Exception:
                    win_ctrl = None
            used = uia_actions.do_select(element, uia, value, win_ctrl=win_ctrl)
            if not used:
                return _coordinate_fallback(ctx, target, "click")
            return {"used": used, "option": value}
        if act in ("expand", "collapse"):
            used = uia_actions.do_expand_collapse(element, uia, act == "expand")
            if not used:
                return _coordinate_fallback(ctx, target, "click")
            return {"used": used}
        if act == "scroll":
            direction, times = _parse_scroll(value)
            used = uia_actions.do_scroll(element, uia, direction, times)
            if not used:
                pt = uia_actions.element_clickable_point(element) or uia_actions.element_center(element)
                return {"used": mouse_kb.wheel(direction, times, x=pt[0], y=pt[1], hwnd=hwnd), "direction": direction}
            return {"used": used, "direction": direction, "times": times}
        if act == "focus":
            if uia_actions.do_focus(element, uia):
                return {"used": "uia_focus"}
            return _coordinate_fallback(ctx, target, "click")
        raise err("INVALID_PARAMS", f"动作 {act} 不适用于 UIA 元素目标")

    return ctx.worker.call(_run, max(5.0, ctx.cfg["runtime"]["actTimeoutMs"] / 1000), f"UIA 动作 {act}")


def _point_action(act: str, target, value) -> dict:
    """坐标目标（coords 或 ocr/vlm 文字块中心）。"""
    x, y = target.point
    if act == "click":
        return {"used": mouse_kb.click_at(x, y, count=1, hwnd=target.hwnd), "point": [x, y]}
    if act == "double_click":
        return {"used": mouse_kb.click_at(x, y, count=2, hwnd=target.hwnd), "point": [x, y]}
    if act == "right_click":
        return {"used": mouse_kb.click_at(x, y, button="right", hwnd=target.hwnd), "point": [x, y]}
    if act == "hover":
        return {"used": mouse_kb.hover_at(x, y, hwnd=target.hwnd), "point": [x, y]}
    if act == "type":
        if value is None:
            raise err("INVALID_PARAMS", "type 需要 value=要输入的文本")
        mouse_kb.click_at(x, y, hwnd=target.hwnd)  # 先点击获得焦点
        used, n = mouse_kb.type_text(str(value))
        return {"used": f"click+{used}", "length": n}
    if act == "press":
        if not value:
            raise err("INVALID_PARAMS", "press 需要 value=键组合")
        return {"used": mouse_kb.press_combo(value, hwnd=target.hwnd), "keys": value}
    if act == "scroll":
        direction, times = _parse_scroll(value)
        return {"used": mouse_kb.wheel(direction, times, x=x, y=y, hwnd=target.hwnd),
                "direction": direction, "times": times}
    if act == "drag":
        x2, y2 = _parse_xy(value)
        return {"used": mouse_kb.drag(x, y, x2, y2, hwnd=target.hwnd), "from": [x, y], "to": [x2, y2]}
    if act in ("set_value", "select", "toggle", "check", "uncheck", "expand", "collapse", "invoke", "focus"):
        raise err("INVALID_PARAMS", f"动作 {act} 需要 UIA 元素目标（ref 或 uia 选择器），坐标目标只支持点击类/输入/滚动")
    raise err("INVALID_PARAMS", f"未知动作 {act}")


def _coordinate_fallback(ctx, target, act: str) -> dict:
    """语义不可用时的坐标兜底：必须先把窗口置前台。"""
    point = target.point or target.center_point
    if not point:
        raise err("TARGET_NOT_FOUND", "元素无可用坐标（不可见或零矩形），无法坐标兜底")
    if act == "hover":
        # hover 不产生点击（否则会误触）
        mouse_kb.hover_at(point[0], point[1], hwnd=target.hwnd)
        return {"used": "coordinate_fallback(hover)", "point": list(point),
                "note": "UIA Pattern 不可用，已用坐标悬停兜底（窗口已置前台）"}
    mouse_kb.click_at(point[0], point[1], count=2 if act == "double_click" else 1,
                      button="right" if act == "right_click" else "left",
                      hwnd=target.hwnd)
    out = {"used": f"coordinate_fallback({act})", "point": list(point),
           "note": "UIA Pattern 不可用，已用坐标点击兜底（窗口已置前台）"}
    return out


def _parse_scroll(value: str | None) -> tuple[str, int]:
    v = (value or "down").strip().lower()
    times = 1
    if ":" in v:
        v, n = v.split(":", 1)
        try:
            times = max(1, int(n))
        except ValueError:
            raise err("INVALID_PARAMS", f"scroll 次数非法: {value!r}（示例 down:3）")
    if v not in SCROLL_DIRS:
        raise err("INVALID_PARAMS", f"scroll 方向只支持 {'/'.join(SCROLL_DIRS)}[:次数]，得到 {value!r}")
    return v, times
