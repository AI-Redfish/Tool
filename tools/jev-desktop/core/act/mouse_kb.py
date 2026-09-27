"""SendInput 动作（DESIGN §5）：绝对坐标鼠标、组合键、KEYEVENTF_UNICODE 文本。

长文本（>200 字符）走剪贴板快速通道（Ctrl+V，用完尽力恢复原剪贴板）。
"""

import time

from ..errors import err
from .. import winapi


def click_at(x: int, y: int, *, button: str = "left", count: int = 1, hwnd: int | None = None) -> str:
    _ensure_foreground(hwnd)
    winapi.mouse_move_abs(x, y)
    time.sleep(0.03)
    for i in range(max(1, count)):
        winapi.mouse_click(button)
        if i < count - 1:
            time.sleep(0.06)
    return "coordinate"


def hover_at(x: int, y: int, *, hwnd: int | None = None) -> str:
    _ensure_foreground(hwnd)
    winapi.mouse_move_abs(x, y)
    return "coordinate"


def drag(x1: int, y1: int, x2: int, y2: int, *, steps: int = 12, hwnd: int | None = None) -> str:
    _ensure_foreground(hwnd)
    winapi.mouse_move_abs(x1, y1)
    time.sleep(0.05)
    winapi.mouse_down("left")
    time.sleep(0.05)
    for i in range(1, steps + 1):
        nx = int(x1 + (x2 - x1) * i / steps)
        ny = int(y1 + (y2 - y1) * i / steps)
        winapi.mouse_move_abs(nx, ny)
        time.sleep(0.02)
    winapi.mouse_up("left")
    return "coordinate"


def press_combo(keys: str, *, hwnd: int | None = None) -> str:
    if hwnd:
        _ensure_foreground(hwnd)
    winapi.key_combo(keys)
    return "sendinput_key"


def type_text(text: str, *, hwnd: int | None = None, clipboard_fallback: bool = True) -> tuple[str, int]:
    """输入文本：≤200 字符走 UNICODE 直打；更长走剪贴板+Ctrl+V（恢复原剪贴板）。"""
    if not text:
        return "sendinput_unicode", 0
    if hwnd:
        _ensure_foreground(hwnd)
    if len(text) <= 200 or not clipboard_fallback:
        n = winapi.type_unicode(text)
        return "sendinput_unicode", n
    saved = ""
    try:
        saved = winapi.clipboard_get()
    except Exception:
        pass
    winapi.clipboard_set(text)
    time.sleep(0.05)
    winapi.key_combo("ctrl+v")
    time.sleep(0.2)
    try:
        winapi.clipboard_set(saved)  # 尽力恢复
    except Exception:
        pass
    return "clipboard_paste", len(text)


def wheel(direction: str, times: int, *, x: int | None = None, y: int | None = None, hwnd: int | None = None) -> str:
    if x is not None and y is not None:
        _ensure_foreground(hwnd)
        winapi.mouse_move_abs(x, y)
        time.sleep(0.03)
    delta = -120 if direction == "down" else 120
    for _ in range(max(1, times)):
        winapi.mouse_wheel(delta)
        time.sleep(0.03)
    return "coordinate"


def ensure_foreground(hwnd: int | None) -> None:
    """确保目标窗口在前台（键盘输入前置条件）；失败抛 INPUT_DENIED。"""
    _ensure_foreground(hwnd)


def _ensure_foreground(hwnd: int | None) -> None:
    """坐标动作前置条件：目标窗口在前台（DESIGN §5）。失败时给出可操作错误。"""
    if hwnd is None:
        return
    if not winapi.is_window(hwnd):
        raise err("WINDOW_LOST", f"窗口 {hwnd} 已不存在，无法执行坐标动作")
    if winapi.user32.GetForegroundWindow() == hwnd:
        return
    if not winapi.focus_window(hwnd):
        raise err("INPUT_DENIED",
                  f"无法把窗口 {hwnd} 置前台（前台锁/UIPI 限制）；坐标动作要求目标窗口在前台，"
                  "请手动切换后重试，或改用 UIA 语义动作（不抢焦点）")
    time.sleep(0.08)  # 前台切换稳定
