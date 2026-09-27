"""Win32 原生层（纯 ctypes，不依赖第三方包）。

覆盖：DPI 感知、虚拟屏坐标、顶层窗口枚举、窗口置前、SendInput 鼠标/键盘
（KEYEVENTF_UNICODE 直打中文）、剪贴板读写。坐标一律为物理像素。

不使用 pyautogui/pywin32（DESIGN §3）；这是 act/mouse_kb、act/winmgmt、
act/clipboard 的底层，observe/screenshot 也用到虚拟屏信息。
"""

import ctypes
import ctypes.wintypes as wt
import time

from .errors import err

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)
ole32 = ctypes.WinDLL("ole32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)

# Win64 正确性：返回指针/句柄的函数必须显式 restype（ctypes 默认 32 位 int 会截断）
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = (ctypes.c_uint, ctypes.c_size_t)
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = (ctypes.c_void_p,)
kernel32.GlobalUnlock.argtypes = (ctypes.c_void_p,)
kernel32.GlobalFree.argtypes = (ctypes.c_void_p,)
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong)
kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
kernel32.QueryFullProcessImageNameW.argtypes = (ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(wt.DWORD))
user32.GetClipboardData.restype = ctypes.c_void_p
user32.GetClipboardData.argtypes = (ctypes.c_uint,)
user32.SetClipboardData.restype = ctypes.c_void_p
user32.SetClipboardData.argtypes = (ctypes.c_uint, ctypes.c_void_p)
user32.GetForegroundWindow.restype = ctypes.c_void_p
user32.SetForegroundWindow.argtypes = (ctypes.c_void_p,)
user32.IsWindow.argtypes = (ctypes.c_void_p,)
user32.IsWindowVisible.argtypes = (ctypes.c_void_p,)
user32.IsIconic.argtypes = (ctypes.c_void_p,)
user32.IsHungAppWindow.argtypes = (ctypes.c_void_p,)
user32.BringWindowToTop.argtypes = (ctypes.c_void_p,)
user32.ShowWindow.argtypes = (ctypes.c_void_p, ctypes.c_int)
user32.SetWindowPos.argtypes = (ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint)
user32.GetWindowRect.argtypes = (ctypes.c_void_p, ctypes.POINTER(wt.RECT))
user32.GetWindowTextLengthW.argtypes = (ctypes.c_void_p,)
user32.GetWindowTextW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int)
user32.GetClassNameW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int)
user32.GetWindowThreadProcessId.argtypes = (ctypes.c_void_p, ctypes.POINTER(wt.DWORD))
user32.GetWindowLongW.argtypes = (ctypes.c_void_p, ctypes.c_int)
user32.AttachThreadInput.argtypes = (ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int)
user32.SendMessageTimeoutW.argtypes = (ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(wt.DWORD))
user32.EnumWindows.argtypes = (ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM), wt.LPARAM)
user32.OpenClipboard.argtypes = (ctypes.c_void_p,)
user32.EmptyClipboard.restype = ctypes.c_int
user32.CloseClipboard.restype = ctypes.c_int

# ---------------------------------------------------------------------------

_DPI_PMV2 = ctypes.c_void_p(-4)  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
_SM_XVIRTUALSCREEN = 76
_SM_YVIRTUALSCREEN = 77
_SM_CXVIRTUALSCREEN = 78
_SM_CYVIRTUALSCREEN = 79

MOUSE_MOVE = 0x0001
MOUSE_LEFTDOWN = 0x0002
MOUSE_LEFTUP = 0x0004
MOUSE_RIGHTDOWN = 0x0008
MOUSE_RIGHTUP = 0x0010
MOUSE_MIDDLEDOWN = 0x0020
MOUSE_MIDDLEUP = 0x0040
MOUSE_WHEEL = 0x0800
MOUSE_ABSOLUTE = 0x8000
MOUSE_VIRTUALDESK = 0x4000

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WM_CLOSE = 0x0010
SW_RESTORE = 9
SW_MINIMIZE = 6
SW_MAXIMIZE = 3

_CF_UNICODETEXT = 13
_GMEM_MOVEABLE = 0x0002


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", ctypes.c_ulong),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.c_void_p)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.c_void_p)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", ctypes.c_ulong), ("wParamL", ctypes.c_ushort), ("wParamH", ctypes.c_ushort)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", ctypes.c_ulong), ("u", _INPUTUNION)]


# ---------------------------------------------------------------------------
# DPI
# ---------------------------------------------------------------------------

_dpi_applied = False
_dpi_mode = "未设置"


def ensure_dpi_awareness() -> str:
    """进程级一次性设置（必须在创建窗口/截图/UIA 之前调用）。返回模式描述。"""
    global _dpi_applied, _dpi_mode
    if _dpi_applied:
        return _dpi_mode
    if hasattr(user32, "SetProcessDpiAwarenessContext"):
        try:
            if user32.SetProcessDpiAwarenessContext(_DPI_PMV2):
                _dpi_mode = "PER_MONITOR_AWARE_V2"
        except Exception:
            pass
    if _dpi_applied is False and _dpi_mode == "未设置" and hasattr(ctypes.windll, "shcore"):
        try:
            if ctypes.windll.shcore.SetProcessDpiAwareness(2) == 0:  # PROCESS_PER_MONITOR_DPI_AWARE
                _dpi_mode = "PER_MONITOR_AWARE"
        except Exception:
            pass
    if _dpi_mode == "未设置":
        try:
            if user32.SetProcessDPIAware():
                _dpi_mode = "SYSTEM_AWARE"
        except Exception:
            pass
    _dpi_applied = True
    return _dpi_mode


def virtual_screen() -> tuple[int, int, int, int]:
    return (user32.GetSystemMetrics(_SM_XVIRTUALSCREEN),
            user32.GetSystemMetrics(_SM_YVIRTUALSCREEN),
            user32.GetSystemMetrics(_SM_CXVIRTUALSCREEN),
            user32.GetSystemMetrics(_SM_CYVIRTUALSCREEN))


# ---------------------------------------------------------------------------
# SendInput
# ---------------------------------------------------------------------------

def _send_inputs(items: list[INPUT]) -> None:
    arr = (INPUT * len(items))(*items)
    sent = user32.SendInput(len(items), arr, ctypes.sizeof(INPUT))
    if sent != len(items):
        # 事件被 UIPI 拦截（目标窗口提权）等
        raise err("INPUT_DENIED",
                  f"SendInput 仅注入 {sent}/{len(items)} 个事件，通常因为目标窗口以管理员运行而本进程不是"
                  "（UIPI 隔离）；请以管理员重开终端后再试",
                  details={"blocked": len(items) - sent})


def _abs_xy(x: int, y: int) -> tuple[int, int]:
    vx, vy, vw, vh = virtual_screen()
    if vw <= 1 or vh <= 1:
        raise err("INTERNAL_ERROR", f"虚拟屏尺寸异常: {virtual_screen()}")
    nx = int(round((x - vx) * 65535 / (vw - 1)))
    ny = int(round((y - vy) * 65535 / (vh - 1)))
    return min(65535, max(0, nx)), min(65535, max(0, ny))


def mouse_move_abs(x: int, y: int) -> None:
    nx, ny = _abs_xy(x, y)
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(nx, ny, 0, MOUSE_MOVE | MOUSE_ABSOLUTE | MOUSE_VIRTUALDESK, 0, None)
    _send_inputs([inp])


def mouse_button(flags_down: int, flags_up: int) -> None:
    items = []
    d = INPUT(type=INPUT_MOUSE)
    d.mi = MOUSEINPUT(0, 0, 0, flags_down, 0, None)
    items.append(d)
    u = INPUT(type=INPUT_MOUSE)
    u.mi = MOUSEINPUT(0, 0, 0, flags_up, 0, None)
    items.append(u)
    _send_inputs(items)


def mouse_down(button: str = "left") -> None:
    flag = {"left": MOUSE_LEFTDOWN, "right": MOUSE_RIGHTDOWN, "middle": MOUSE_MIDDLEDOWN}[button]
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(0, 0, 0, flag, 0, None)
    _send_inputs([inp])


def mouse_up(button: str = "left") -> None:
    flag = {"left": MOUSE_LEFTUP, "right": MOUSE_RIGHTUP, "middle": MOUSE_MIDDLEUP}[button]
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(0, 0, 0, flag, 0, None)
    _send_inputs([inp])


def mouse_click(button: str = "left") -> None:
    mapping = {
        "left": (MOUSE_LEFTDOWN, MOUSE_LEFTUP),
        "right": (MOUSE_RIGHTDOWN, MOUSE_RIGHTUP),
        "middle": (MOUSE_MIDDLEDOWN, MOUSE_MIDDLEUP),
    }
    down, up = mapping.get(button) or mapping["left"]
    mouse_button(down, up)


def mouse_wheel(delta: int) -> None:
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(0, 0, delta & 0xFFFFFFFF, MOUSE_WHEEL, 0, None)
    _send_inputs([inp])


_KEY_MAP: dict[str, tuple[int, bool]] = {
    "enter": (0x0D, False), "return": (0x0D, False), "tab": (0x09, False), "esc": (0x1B, False),
    "escape": (0x1B, False), "space": (0x20, False), "backspace": (0x08, False), "bksp": (0x08, False),
    "delete": (0x2E, True), "del": (0x2E, True), "insert": (0x2D, True), "ins": (0x2D, True),
    "home": (0x24, True), "end": (0x23, True), "pageup": (0x21, True), "pgup": (0x21, True),
    "pagedown": (0x22, True), "pgdn": (0x22, True), "up": (0x26, True), "down": (0x28, True),
    "left": (0x25, True), "right": (0x27, True), "printscreen": (0x2C, True), "prtsc": (0x2C, True),
    "capslock": (0x14, False), "numlock": (0x90, True), "scrolllock": (0x91, False), "pause": (0x13, False),
    "win": (0x5B, True), "lwin": (0x5B, True), "rwin": (0x5C, True), "apps": (0x5D, True), "menu": (0x5D, True),
    "ctrl": (0x11, False), "lctrl": (0x11, False), "rctrl": (0xA3, True),
    "alt": (0x12, False), "lalt": (0x12, False), "ralt": (0xA5, True),
    "shift": (0x10, False), "lshift": (0x10, False), "rshift": (0xA1, True),
    "plus": (0xBB, False), "minus": (0xBD, False), "equal": (0xBB, False),
    "[": (0xDB, False), "]": (0xDD, False), "\\": (0xDC, False), ";": (0xBA, False), "'": (0xDE, False),
    ",": (0xBC, False), ".": (0xBE, False), "/": (0xBF, False), "`": (0xC0, False),
}
for _i in range(26):
    _KEY_MAP[chr(ord("a") + _i)] = (0x41 + _i, False)
for _i in range(10):
    _KEY_MAP[str(_i)] = (0x30 + _i, False)
for _i in range(24):
    _KEY_MAP[f"f{_i + 1}"] = (0x70 + _i, False)


def parse_combo(text: str) -> list[tuple[int, bool]]:
    """解析 'ctrl+s' / 'ctrl+shift+esc' / 'a'。单字符未映射时退化为 VK 码。"""
    parts = [p.strip().lower() for p in text.split("+") if p.strip()]
    if not parts:
        raise err("INVALID_PARAMS", f"键组合为空: {text!r}")
    out: list[tuple[int, bool]] = []
    for p in parts:
        if p in _KEY_MAP:
            out.append(_KEY_MAP[p])
        elif len(p) == 1:
            out.append((ord(p.upper()), False))
        else:
            raise err("INVALID_PARAMS", f"无法识别的键名 \"{p}\"（组合: {text!r}）")
    return out


def key_press(vk: int, extended: bool = False) -> None:
    flags = KEYEVENTF_EXTENDEDKEY if extended else 0
    d = INPUT(type=INPUT_KEYBOARD)
    d.ki = KEYBDINPUT(vk, 0, flags, 0, None)
    u = INPUT(type=INPUT_KEYBOARD)
    u.ki = KEYBDINPUT(vk, 0, flags | KEYEVENTF_KEYUP, 0, None)
    _send_inputs([d, u])


def key_combo(text: str) -> None:
    """按下组合键：修饰键按住 → 最后一个键 → 全部释放。"""
    combo = parse_combo(text)
    down_items = []
    for vk, ext in combo:
        flags = KEYEVENTF_EXTENDEDKEY if ext else 0
        inp = INPUT(type=INPUT_KEYBOARD)
        inp.ki = KEYBDINPUT(vk, 0, flags, 0, None)
        down_items.append(inp)
    up_items = []
    for vk, ext in reversed(combo):
        flags = KEYEVENTF_EXTENDEDKEY if ext else 0
        inp = INPUT(type=INPUT_KEYBOARD)
        inp.ki = KEYBDINPUT(vk, 0, flags | KEYEVENTF_KEYUP, 0, None)
        up_items.append(inp)
    _send_inputs(down_items + up_items)


def type_unicode(text: str) -> int:
    """KEYEVENTF_UNICODE 直打文本（绕过输入法，DESIGN §14）。返回字符数。"""
    units: list[str] = []
    for ch in text:
        cp = ord(ch)
        if cp > 0xFFFF:
            cp -= 0x10000
            units.append(chr(0xD800 + (cp >> 10)))
            units.append(chr(0xDC00 + (cp & 0x3FF)))
        else:
            units.append(ch)
    items = []
    for u in units:
        d = INPUT(type=INPUT_KEYBOARD)
        d.ki = KEYBDINPUT(0, ord(u), KEYEVENTF_UNICODE, 0, None)
        up = INPUT(type=INPUT_KEYBOARD)
        up.ki = KEYBDINPUT(0, ord(u), KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, None)
        items.append(d)
        items.append(up)
    # 分批发送，避免超长数组
    for i in range(0, len(items), 64):
        _send_inputs(items[i:i + 64])
    return len(text)


# ---------------------------------------------------------------------------
# 窗口枚举与置前
# ---------------------------------------------------------------------------

_SKIP_CLASSES = {
    "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "SysListView32",
    "MicrosoftWindowsTooltip", "#32769", "Windows.UI.Core.CoreWindow", "_MSUiHost", "ApplicationFrameInputSinkWindow",
}


class WindowInfo:
    __slots__ = ("hwnd", "title", "pid", "process", "rect", "klass", "foreground", "minimized")

    def __init__(self, hwnd: int, title: str, pid: int, process: str, rect: tuple, klass: str, foreground: bool, minimized: bool):
        self.hwnd = hwnd
        self.title = title
        self.pid = pid
        self.process = process
        self.rect = rect
        self.klass = klass
        self.foreground = foreground
        self.minimized = minimized

    def to_dict(self) -> dict:
        l, t, r, b = self.rect
        return {"id": self.hwnd, "hwnd": self.hwnd, "title": self.title, "pid": self.pid,
                "process": self.process, "class": self.klass,
                "rect": {"left": l, "top": t, "right": r, "bottom": b},
                "foreground": self.foreground, "minimized": self.minimized}


def _window_class_name(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _process_name(pid: int) -> str:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            path = buf.value
            return path.replace("/", "\\").rsplit("\\", 1)[-1]
        return ""
    finally:
        kernel32.CloseHandle(h)


def window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    rect = wt.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return (rect.left, rect.top, rect.right, rect.bottom)


def is_window(hwnd: int) -> bool:
    return bool(user32.IsWindow(hwnd))


def window_pid(hwnd: int) -> int:
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def window_title(hwnd: int) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def list_top_windows() -> list[WindowInfo]:
    """可见顶层窗口（含最小化，已标记）；跳过任务栏/桌面等外壳与工具窗。"""
    ensure_dpi_awareness()
    results: list[WindowInfo] = []
    fg = user32.GetForegroundWindow()

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        klass = _window_class_name(hwnd)
        if klass in _SKIP_CLASSES:
            return True
        ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        if ex & WS_EX_TOOLWINDOW:
            return True
        title = window_title(hwnd)
        if not title:
            return True
        try:
            cloaked = wt.DWORD(0)
            if dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)) == 0 and cloaked.value != 0:
                return True
        except Exception:
            pass
        rect = window_rect(hwnd)
        if not rect:
            return True
        pid = window_pid(hwnd)
        minimized = bool(user32.IsIconic(hwnd))
        # 最小化窗口的 GetWindowRect 是 (-32000,...) 占位值，不做矩形合法性检查
        if not minimized and (rect[2] <= rect[0] or rect[3] <= rect[1]):
            return True
        results.append(WindowInfo(hwnd, title, pid, _process_name(pid), rect, klass, hwnd == fg, minimized))
        return True

    user32.EnumWindows(cb, 0)
    results.sort(key=lambda w: ((not w.foreground), w.minimized, -(w.rect[2] * w.rect[3])))
    return results


def ensure_restored(hwnd: int, *, wait_s: float = 0.3) -> bool:
    """最小化窗口先还原（观察/截图/坐标动作的前提）。返回是否发生了还原。"""
    if not is_window(hwnd) or not user32.IsIconic(hwnd):
        return False
    user32.ShowWindow(hwnd, SW_RESTORE)
    time.sleep(wait_s)
    return True


def focus_window(hwnd: int, *, timeout_s: float = 2.0) -> bool:
    """把窗口置前台（处理 SetForegroundWindow 前台锁限制）。失败返回 False。"""
    ensure_dpi_awareness()
    if not is_window(hwnd):
        return False
    deadline = time.monotonic() + timeout_s
    if user32.GetForegroundWindow() == hwnd:
        return True
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(0.15)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    if user32.GetForegroundWindow() == hwnd:
        return True
    # AttachThreadInput 技巧：借前台线程的输入队列
    fg = user32.GetForegroundWindow()
    cur_tid = kernel32.GetCurrentThreadId()
    fg_tid = user32.GetWindowThreadProcessId(fg, None)
    tgt_tid = user32.GetWindowThreadProcessId(hwnd, None)
    if fg_tid and fg_tid != cur_tid:
        user32.AttachThreadInput(cur_tid, fg_tid, True)
    if tgt_tid and tgt_tid != cur_tid:
        user32.AttachThreadInput(cur_tid, tgt_tid, True)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if fg_tid and fg_tid != cur_tid:
            user32.AttachThreadInput(cur_tid, fg_tid, False)
        if tgt_tid and tgt_tid != cur_tid:
            user32.AttachThreadInput(cur_tid, tgt_tid, False)
    if user32.GetForegroundWindow() == hwnd:
        return True
    # ALT 键技巧绕过前台锁
    d = INPUT(type=INPUT_KEYBOARD)
    d.ki = KEYBDINPUT(0x12, 0, 0, 0, None)
    u = INPUT(type=INPUT_KEYBOARD)
    u.ki = KEYBDINPUT(0x12, 0, KEYEVENTF_KEYUP, 0, None)
    try:
        _send_inputs([d, u])
    except Exception:
        pass
    user32.SetForegroundWindow(hwnd)
    while time.monotonic() < deadline:
        if user32.GetForegroundWindow() == hwnd:
            return True
        time.sleep(0.05)
    return False


def send_message_safe(hwnd: int, msg: int, wparam: int, lparam: int, timeout_ms: int = 3000) -> bool:
    """SendMessageTimeout：目标挂起时不阻塞工具进程。"""
    result = wt.DWORD(0)
    SMTO_ABORTIFHUNG = 0x0002
    return bool(user32.SendMessageTimeoutW(hwnd, msg, wparam, lparam, SMTO_ABORTIFHUNG, timeout_ms, ctypes.byref(result)))


def is_hung(hwnd: int) -> bool:
    return bool(user32.IsHungAppWindow(hwnd))


def is_user_admin() -> bool:
    try:
        return bool(shell32.IsUserAnAdmin())
    except Exception:
        return False


def show_window(hwnd: int, cmd: int) -> None:
    user32.ShowWindow(hwnd, cmd)


# ---------------------------------------------------------------------------
# 剪贴板
# ---------------------------------------------------------------------------

def clipboard_get() -> str:
    ensure_dpi_awareness()
    for _ in range(6):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise err("INTERNAL_ERROR", "剪贴板打开失败（被其他进程占用）")
    try:
        h = user32.GetClipboardData(_CF_UNICODETEXT)
        if not h:
            return ""
        p = kernel32.GlobalLock(h)
        if not p:
            return ""
        try:
            return ctypes.wstring_at(p)
        finally:
            kernel32.GlobalUnlock(h)
    finally:
        user32.CloseClipboard()


def clipboard_set(text: str) -> None:
    ensure_dpi_awareness()
    for _ in range(6):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise err("INTERNAL_ERROR", "剪贴板打开失败（被其他进程占用）")
    try:
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        h = kernel32.GlobalAlloc(_GMEM_MOVEABLE, len(data))
        if not h:
            raise err("INTERNAL_ERROR", "GlobalAlloc 失败")
        p = kernel32.GlobalLock(h)
        if not p:
            kernel32.GlobalFree(h)
            raise err("INTERNAL_ERROR", "GlobalLock 失败")
        ctypes.memmove(p, data, len(data))
        kernel32.GlobalUnlock(h)
        if not user32.SetClipboardData(_CF_UNICODETEXT, h):
            kernel32.GlobalFree(h)
            raise err("INTERNAL_ERROR", "SetClipboardData 失败")
        # 成功后 h 归系统所有，不再释放
    finally:
        user32.CloseClipboard()


def clipboard_clear() -> None:
    ensure_dpi_awareness()
    for _ in range(6):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise err("INTERNAL_ERROR", "剪贴板打开失败（被其他进程占用）")
    try:
        user32.EmptyClipboard()
    finally:
        user32.CloseClipboard()
