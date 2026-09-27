"""UIA 语义树快照（DESIGN ADR-01/06, §4.1）。

依赖 uiautomation（经 worker 惰性加载）。输出紧凑文本 + 交互元素 ref，
深度/数量截断 + 可下钻 ref（渐进骨架遍历，治理密集应用 token 膨胀）。
全部函数只在 UiaWorker 线程内执行（COM STA）。
"""

from collections import deque

from ..errors import err
from .model import SnapElement

# ref 分配启发式（DESIGN §4.1：交互元素分配 ref）
INTERACTIVE_ROLES = {
    "Button", "SplitButton", "MenuItem", "Hyperlink", "CheckBox", "RadioButton",
    "ComboBox", "TabItem", "TreeItem", "ListItem", "DataItem", "Edit", "Document",
    "Slider", "Spinner", "Calendar",
}
# 叶子节点且可能带 Invoke 的类型：额外探测 InvokePattern
LEAF_PROBE_ROLES = {"Text", "Image", "Pane", "Group", "Table", "TableCell", "Custom",
                    "Header", "HeaderItem", "DataItem", "ListItem", "Thumb", "AppBar"}
# 显示 value 的类型（ValuePattern 查询仅对这些类型做，控耗时）
VALUE_ROLES = {"Edit", "Document", "Spinner", "ComboBox"}
# 尝试 TextPattern 读取内容的类型（终端/文档/富文本）
TEXT_PATTERN_ROLES = {"Document", "Text", "Custom", "Edit"}

_NAME_MAX = 40
_VAL_MAX = 30


def short_role(control_type_name: str) -> str:
    return control_type_name[:-7] if control_type_name.endswith("Control") else control_type_name


def probe_uia(uia, hwnd: int) -> bool:
    """UIA 可用性探测：能否从 hwnd 拿到元素并读到 ControlType。"""
    try:
        c = uia.ControlFromHandle(hwnd)
        if c is None:
            return False
        _ = c.ControlTypeName
        return True
    except Exception:
        return False


def window_control(uia, hwnd: int):
    """取窗口 Control；失败抛 WINDOW_LOST。"""
    try:
        ctrl = uia.ControlFromHandle(hwnd)
    except Exception as e:
        raise err("WINDOW_LOST", f"窗口 {hwnd} 的 UIA 元素获取失败: {e}")
    if ctrl is None:
        raise err("WINDOW_LOST", f"窗口 {hwnd} 已关闭或不再暴露（hwnd 失效）；请重新 desktop_windows 选择目标")
    return ctrl


def walk_tree(uia, win_control, *, snapshot_id: str, hwnd: int, pid: int,
              max_depth: int = 3, max_elements: int = 800,
              root_runtime_id: list[int] | None = None) -> tuple[list[SnapElement], list[str], bool]:
    """BFS 遍历 UIA 树。返回 (elements, lines, truncated)。

    - 每行：role | name | aid | value | 状态 | 矩形，交互元素带 ref；
    - 深度截断的容器标注 children_count 与下钻 ref（渐进骨架）；
    - 超过 max_elements 即截断并标注；
    - root_runtime_id 给定时从该元素开始局部下钻（渐进骨架遍历）。
    """
    elements: list[SnapElement] = []
    lines: list[str] = []
    truncated = False
    start = win_control
    if root_runtime_id:
        start = _find_by_runtime_id(uia, win_control, root_runtime_id)
        if start is None:
            raise err("STALE_REF", "下钻根元素已失效（RuntimeId 重找失败）；请重新快照后再选下钻 ref")
    queue: deque = deque([(start, 0)])

    while queue:
        ctrl, depth = queue.popleft()
        if len(elements) >= max_elements:
            truncated = True
            break
        try:
            info = _read_element(uia, ctrl, snapshot_id, hwnd, pid, depth, index=len(elements) + 1)
        except Exception:
            continue  # 单元素属性读取失败跳过，不让整棵树报废
        # 子节点（先取，便于深度截断时标注 children）
        children: list = []
        if depth < max_depth:
            try:
                children = ctrl.GetChildren() or []
            except Exception:
                children = []
        else:
            try:
                children = ctrl.GetChildren() or []
            except Exception:
                children = []
        info.children_count = len(children)
        elements.append(info)
        lines.append(_render_line(info, drill=depth >= max_depth and len(children) > 0))
        for ch in children:
            queue.append((ch, depth + 1))

    if truncated:
        lines.append(f"… 元素数达到上限 {max_elements}，快照已截断；请用 --root <ref> 下钻关心的区域")
    return elements, lines, truncated


def _read_element(uia, ctrl, snapshot_id: str, hwnd: int, pid: int, depth: int, index: int) -> SnapElement:
    role = short_role(ctrl.ControlTypeName)
    try:
        name = ctrl.Name or ""
    except Exception:
        name = ""
    try:
        aid = ctrl.AutomationId or ""
    except Exception:
        aid = ""
    try:
        klass = ctrl.ClassName or ""
    except Exception:
        klass = ""
    try:
        rect_obj = ctrl.BoundingRectangle
        rect = (int(rect_obj.left), int(rect_obj.top), int(rect_obj.right), int(rect_obj.bottom))
    except Exception:
        rect = (0, 0, 0, 0)
    try:
        offscreen = bool(ctrl.IsOffscreen)
    except Exception:
        offscreen = rect[2] <= rect[0] or rect[3] <= rect[1]

    value = ""
    if role in VALUE_ROLES:
        try:
            vp = ctrl.GetPattern(uia.PatternId.ValuePattern)
            if vp is not None:
                value = vp.Value or ""
        except Exception:
            value = ""
    if not value and role in TEXT_PATTERN_ROLES:
        # 终端/文档类控件常经 TextPattern 暴露内容（如 Windows Terminal），
        # 子元素里看不到文本。优先可见区域（终端最新输出），取末尾 120 字符。
        try:
            tp = ctrl.GetPattern(uia.PatternId.TextPattern)
            if tp is not None:
                text = ""
                try:
                    ranges = tp.GetVisibleRanges() or []
                    if ranges:
                        text = ranges[-1].GetText(400) or ""
                except Exception:
                    text = tp.DocumentRange.GetText(800) or ""
                value = text.strip()[-120:]
        except Exception:
            value = ""

    toggle_state = None
    if role in ("CheckBox", "RadioButton"):
        try:
            tp_ = ctrl.GetPattern(uia.PatternId.TogglePattern)
            if tp_ is not None:
                toggle_state = int(tp_.ToggleState)
        except Exception:
            toggle_state = None

    interactive = role in INTERACTIVE_ROLES
    if not interactive and role in LEAF_PROBE_ROLES:
        try:
            interactive = ctrl.GetPattern(uia.PatternId.InvokePattern) is not None
        except Exception:
            interactive = False

    try:
        runtime_id = [int(x) for x in (ctrl.GetRuntimeId() or [])]
    except Exception:
        runtime_id = []

    val_disp = _clip_val(value)
    fingerprint = f"{role}|{name[:60]}|{aid[:60]}|{klass[:60]}"
    return SnapElement(
        ref=f"@{snapshot_id}:e{index}",
        role=role, name=name, automation_id=aid, class_name=klass, value=val_disp,
        rect=rect, offscreen=offscreen, interactive=interactive, children_count=0,
        depth=depth, runtime_id=runtime_id, hwnd=hwnd, pid=pid, fingerprint=fingerprint,
        toggle_state=toggle_state,
    )


def _clip(s: str, n: int = _NAME_MAX) -> str:
    s = (s or "").replace("\n", " ").replace("\r", " ").strip()
    return s[:n] + ("…" if len(s) > n else "")


def _clip_val(s: str) -> str:
    s = (s or "").replace("\n", " ").replace("\r", " ").strip()
    return s[:120] + ("…" if len(s) > 120 else "")


def _render_line(info: SnapElement, *, drill: bool = False) -> str:
    indent = "  " * min(info.depth, 8)
    parts = [f"[{info.ref}] {info.role}"]
    if info.name:
        parts.append(f'"{info.name if len(info.name) <= _NAME_MAX else info.name[:_NAME_MAX] + "…"}"')
    if info.automation_id:
        parts.append(f"aid={info.automation_id[:40]}")
    if info.value:
        parts.append(f'val="{info.value}"')
    l, t, r, b = info.rect
    parts.append(f"({l},{t},{r},{b})")
    if info.toggle_state is not None:
        parts.append({0: "未勾选", 1: "已勾选", 2: "半选"}.get(info.toggle_state, f"state={info.toggle_state}"))
    if info.offscreen:
        parts.append("不可见")
    line = indent + " ".join(parts)
    if drill:
        line += f" 子节点={info.children_count} 可下钻: snapshot --root {info.ref}"
    return line


def render_text(snapshot_id: str, window: dict, lines: list[str], *, level: str,
                truncated: bool, notes: list[str] | None = None) -> str:
    title = window.get("title", "")
    head = (f'# 快照 @{snapshot_id} 窗口:"{title}" pid={window.get("pid")} '
            f"hwnd={window.get('hwnd')} level={level} 截断={'是' if truncated else '否'}")
    out = [head]
    out.extend(lines)
    for note in notes or []:
        out.append(f"# note: {note}")
    out.append("# 动作引用: act 用 target={\"kind\":\"ref\",\"ref\":\"@...:eN\"}；文字块为 :bN")
    return "\n".join(out)


def find_by_fingerprint(uia, win_control, fingerprint: str, runtime_id: list[int] | None,
                        old_rect: tuple | None, *, search_depth: int = 12):
    """按指纹（ControlType|Name|AutomationId|ClassName）在窗口子树内重找元素。

    返回 (control, candidates)；control 为最佳匹配（或 None），candidates 为全部匹配数。
    用于 ref 活性校验（ADR-03）：指纹匹配 + RuntimeId 一致优先 + 矩形漂移最小优先。
    """
    try:
        role, name, aid, klass = fingerprint.split("|", 3)
    except ValueError:
        return None, 0
    matches: list = []

    def compare(c) -> bool:
        try:
            # 与指纹存储口径一致（均截断到 60 字符），避免长名称假阴性
            if short_role(c.ControlTypeName) != role:
                return False
            if aid and (c.AutomationId or "")[:60] != aid:
                return False
            if klass and (c.ClassName or "")[:60] != klass:
                return False
            if name and (c.Name or "")[:60] != name:
                return False
            return True
        except Exception:
            return False

    try:
        matches = win_control.Control(searchDepth=search_depth, Compare=compare).FoundControlIdsAndControls()[-1] \
            if False else _find_all(uia, win_control, compare, search_depth)
    except Exception:
        matches = []
    if not matches:
        return None, 0
    if len(matches) == 1:
        return matches[0], 1
    # 多匹配：RuntimeId 一致优先，其次矩形漂移最小
    def score(c):
        try:
            rid = [int(x) for x in (c.GetRuntimeId() or [])]
            if runtime_id and rid and rid == runtime_id:
                return -1
        except Exception:
            pass
        try:
            r = c.BoundingRectangle
            rect = (int(r.left), int(r.top), int(r.right), int(r.bottom))
        except Exception:
            return 10**9
        if not old_rect:
            return 10**8
        ox, oy = (old_rect[0] + old_rect[2]) / 2, (old_rect[1] + old_rect[3]) / 2
        nx, ny = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
        return int(((ox - nx) ** 2 + (oy - ny) ** 2) ** 0.5)

    matches.sort(key=score)
    return matches[0], len(matches)


def _find_by_runtime_id(uia, win_control, runtime_id: list[int]):
    """在窗口子树内按 RuntimeId 精确重找元素（用于 --root 下钻）。"""
    target = [int(x) for x in runtime_id]

    def compare(c) -> bool:
        try:
            return [int(x) for x in (c.GetRuntimeId() or [])] == target
        except Exception:
            return False

    matches = _find_all(uia, win_control, compare, 24)
    return matches[0] if matches else None


def _find_all(uia, win_control, compare, search_depth: int) -> list:
    """不依赖 FindFirstBuildCache 的显式遍历（返回全部匹配，受上限保护）。"""
    out: list = []
    queue: deque = deque([win_control])
    limit = 3000
    seen = 0
    while queue and seen < limit:
        cur = queue.popleft()
        seen += 1
        if cur is not win_control:
            try:
                if compare(cur):
                    out.append(cur)
                    if len(out) >= 64:
                        break
            except Exception:
                pass
        try:
            for ch in cur.GetChildren():
                queue.append(ch)
        except Exception:
            pass
    return out
