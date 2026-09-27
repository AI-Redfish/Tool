import time

"""UIA Pattern 语义动作（DESIGN §5）：不抢焦点，对用户干扰最小。

仅操作已解析的 UIA Control（由 targeting 在 worker 线程内解析），
全部函数只在 UiaWorker 线程内执行。找不到 Pattern 时由 Actor 决定坐标兜底。
"""

from ..errors import JevError, err


def _pat(ctrl, uia, pattern_id):
    try:
        return ctrl.GetPattern(pattern_id)
    except Exception:
        return None


def do_invoke(ctrl, uia) -> str:
    """Invoke；无 InvokePattern 时退化 LegacyIAccessible.DoDefaultAction。返回使用通道。"""
    p = _pat(ctrl, uia, uia.PatternId.InvokePattern)
    if p is not None:
        p.Invoke()
        return "uia_invoke"
    la = _pat(ctrl, uia, uia.PatternId.LegacyIAccessiblePattern)
    if la is not None:
        try:
            la.DoDefaultAction()
            return "uia_legacy"
        except Exception:
            pass
    return ""


def do_set_value(ctrl, uia, value: str) -> str:
    """ValuePattern.SetValue；不可用返回空串（由 Actor 兜底 type）。"""
    p = _pat(ctrl, uia, uia.PatternId.ValuePattern)
    if p is None:
        return ""
    if not p.SetValue(str(value)):
        raise err("INPUT_DENIED", "ValuePattern.SetValue 失败（控件可能只读或被 UIPI 隔离）")
    return "uia_value"


def get_value(ctrl, uia) -> str:
    p = _pat(ctrl, uia, uia.PatternId.ValuePattern)
    if p is None:
        return ""
    try:
        return p.Value or ""
    except Exception:
        return ""


def toggle_state_of(ctrl, uia) -> int | None:
    """读取 ToggleState（0=未选 1=已选 2=半选）；不支持时返回 None。"""
    return _toggle_state(ctrl, uia)


def _toggle_state(ctrl, uia) -> int | None:
    p = _pat(ctrl, uia, uia.PatternId.TogglePattern)
    if p is None:
        return None
    try:
        return int(p.ToggleState)
    except Exception:
        return None


def do_toggle(ctrl, uia) -> str:
    p = _pat(ctrl, uia, uia.PatternId.TogglePattern)
    if p is None:
        return ""
    p.Toggle()
    return "uia_toggle"


def do_check(ctrl, uia, target_state: int) -> tuple[bool, int]:
    """确保 ToggleState 达到目标（0=Off 1=On）。返回 (changed, 当前状态)。"""
    state = _toggle_state(ctrl, uia)
    if state is None:
        raise err("TARGET_NOT_FOUND", "目标不支持 TogglePattern（非复选类控件）")
    if state == target_state:
        return False, state
    p = _pat(ctrl, uia, uia.PatternId.TogglePattern)
    for _ in range(3):
        p.Toggle()
        state = _toggle_state(ctrl, uia)
        if state == target_state:
            return True, state
    return True, state if state is not None else -1


def do_select(ctrl, uia, value: str | None = None, win_ctrl=None) -> str:
    """SelectionItem.Select；value 非空时在下拉/列表子项中按名匹配后选择。

    WinForms DropDownList 等收起时不暴露子项：先 Expand 再在整个顶层窗口范围找
    （弹出项常挂在窗口其他位置），选中后 Collapse。无 value 时直接对目标 Select。
    """
    target = ctrl
    expanded = False
    if value:
        try:
            target = _find_item_by_name(ctrl, uia, value)
        except JevError:
            ec = _pat(ctrl, uia, uia.PatternId.ExpandCollapsePattern)
            if ec is not None:
                ec.Expand()
                expanded = True
                time.sleep(0.3)
                scope = win_ctrl or _top_ancestor(ctrl, uia)
                try:
                    target = _find_item_by_name(scope, uia, value)
                except JevError:
                    target = None
            else:
                target = None
        if target is None:
            # WinForms 等不支持 ExpandCollapse/子项不暴露的下拉：
            # 用 uiautomation 内建的 ComboBox.Select（点击展开→查找并点击列表项，社区验证充分）。
            # 该路径使用真实点击，需要目标窗口在前台。
            select_fn = getattr(ctrl, "Select", None)
            if select_fn is not None:
                ok = bool(select_fn(value))
                return "uia_select_combo" if ok else ""
            raise err("TARGET_NOT_FOUND", f"下拉/列表中找不到选项 \"{value}\"")
    p = _pat(target, uia, uia.PatternId.SelectionItemPattern)
    if p is None:
        if expanded:
            try:
                _pat(ctrl, uia, uia.PatternId.ExpandCollapsePattern).Collapse()
            except Exception:
                pass
        return ""
    p.Select()
    if expanded:
        try:
            _pat(ctrl, uia, uia.PatternId.ExpandCollapsePattern).Collapse()
        except Exception:
            pass
    return "uia_select"


def _top_ancestor(ctrl, uia):
    """向上找顶层窗口（NativeWindowHandle 非 0 或无父）。"""
    cur = ctrl
    for _ in range(12):
        try:
            if cur.NativeWindowHandle:
                return cur
            parent = cur.GetParentControl()
        except Exception:
            return cur
        if parent is None:
            return cur
        cur = parent
    return cur


def _find_item_by_name(ctrl, uia, value: str):
    from ..observe.uia_tree import _find_all

    def compare(c) -> bool:
        try:
            from ..observe.uia_tree import short_role
            return short_role(c.ControlTypeName) in ("ListItem", "ComboBoxItem", "DataItem", "TreeItem", "RadioButton", "TabItem") \
                and (c.Name or "") == value
        except Exception:
            return False

    matches = _find_all(uia, ctrl, compare, 8)
    if not matches:
        raise err("TARGET_NOT_FOUND", f"下拉/列表中找不到选项 \"{value}\"")
    return matches[0]


def do_expand_collapse(ctrl, uia, expand: bool) -> str:
    p = _pat(ctrl, uia, uia.PatternId.ExpandCollapsePattern)
    if p is None:
        return ""
    if expand:
        p.Expand()
    else:
        p.Collapse()
    return "uia_expand" if expand else "uia_collapse"


def do_scroll(ctrl, uia, direction: str, times: int) -> str:
    """ScrollPattern 大步幅滚动；不支持时返回空串（Actor 兜底鼠标滚轮）。"""
    p = _pat(ctrl, uia, uia.PatternId.ScrollPattern)
    if p is None:
        return ""
    sa = uia.ScrollAmount
    amount = sa.LargeIncrement
    if direction in ("up", "left"):
        amount = sa.LargeDecrement
    for _ in range(max(1, times)):
        if direction in ("up", "down"):
            p.Scroll(uia.ScrollAmount.NoAmount, amount)
        else:
            p.Scroll(amount, uia.ScrollAmount.NoAmount)
    return "uia_scroll"


def do_focus(ctrl, uia) -> bool:
    try:
        return bool(ctrl.SetFocus())
    except Exception:
        return False


def element_rect(ctrl) -> tuple[int, int, int, int]:
    r = ctrl.BoundingRectangle
    return (int(r.left), int(r.top), int(r.right), int(r.bottom))


def element_clickable_point(ctrl) -> tuple[int, int] | None:
    try:
        x, y, ok = ctrl.GetClickablePoint()
        if ok:
            return (int(x), int(y))
    except Exception:
        pass
    return None


def element_center(ctrl) -> tuple[int, int]:
    l, t, r, b = element_rect(ctrl)
    return ((l + r) // 2, (t + b) // 2)
