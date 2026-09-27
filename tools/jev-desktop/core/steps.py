"""execute 契约（DESIGN §8）：FlowStep / TargetSpec 严格校验与规范化。

模型（规划器）只能产出白名单步骤；调用者传入的步骤同样过这道闸。
禁任意代码；${var} 只做白名单变量插值。
"""

import re
from .errors import err

# execute 契约 act 白名单（DESIGN §8）+ 实现超集（hover/drag/invoke/check/uncheck/
# minimize/maximize/restore/move/resize，与 desktop_act 对齐，README 注明）
ACTIONS = {
    "click", "double_click", "right_click", "hover", "drag",
    "type", "set_value", "press", "scroll", "select",
    "toggle", "check", "uncheck", "expand", "collapse",
    "focus", "invoke",
    "launch", "close", "minimize", "maximize", "restore", "move", "resize",
    "clipboard_get", "clipboard_set",
}
NEED_TARGET = {"click", "double_click", "right_click", "hover", "drag", "set_value",
               "scroll", "select", "toggle", "check", "uncheck", "expand", "collapse",
               "focus", "invoke"}
# type/press 支持无目标（输入到当前焦点/目标窗口），与 desktop_act 语义一致
NEED_VALUE = {"type", "set_value", "press", "launch", "move", "resize", "clipboard_set", "drag"}
EXPECT_KINDS = {"element_exists", "element_gone", "text_present", "window_title_contains"}
WAIT_MODES = {"element", "text", "time"}
EXTRACT_FIELDS = {"text", "value", "rect", "enabled", "checked"}
ASSERT_OPS = {"var_equals", "var_contains", "var_exists", "element_exists", "element_gone",
              "window_title_contains"}
VAR_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
STEP_KINDS = {"action", "wait", "screenshot", "extract", "assert", "goal"}
MAX_STEPS = 200


def substitute(value, variables: dict, where: str):
    """${name} 白名单插值：只替换 variables 中存在的名字，未知变量报 INVALID_STEP。"""
    if isinstance(value, dict):
        return {k: substitute(v, variables, f"{where}.{k}") for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, variables, f"{where}[{i}]") for i, v in enumerate(value)]
    if not isinstance(value, str):
        return value

    def _sub(m):
        name = m.group(1)
        if name not in variables:
            raise err("INVALID_STEP", f"{where}: 引用了未定义变量 ${{{name}}}（可用: {sorted(variables)}）")
        return str(variables[name])

    return VAR_PATTERN.sub(_sub, value)


def validate_steps(raw, *, where: str = "steps", variables: dict | None = None) -> list[dict]:
    """校验 FlowStep 数组并应用 ${var} 插值。返回规范化步骤列表。"""
    if not isinstance(raw, list) or not raw:
        raise err("INVALID_STEP", f"{where} 必须是非空数组")
    if len(raw) > MAX_STEPS:
        raise err("INVALID_STEP", f"{where} 步骤数 {len(raw)} 超过上限 {MAX_STEPS}")
    variables = variables if variables is not None else {}
    out: list[dict] = []
    for i, s in enumerate(raw):
        out.append(validate_step(s, where=f"{where}[{i}]", index=i, variables=variables))
    return out


def validate_step(s, *, where: str, index: int, variables: dict) -> dict:
    if not isinstance(s, dict):
        raise err("INVALID_STEP", f"{where}: 步骤必须是对象")
    from .targeting import validate_target_spec

    kind = s.get("kind")
    if kind not in STEP_KINDS:
        raise err("INVALID_STEP", f"{where}: kind 非法 {kind!r}（{sorted(STEP_KINDS)}）")
    step_id = s.get("id")
    if step_id is not None:
        step_id = str(step_id)
        if not ID_PATTERN.match(step_id):
            raise err("INVALID_STEP", f"{where}: id 非法 {step_id!r}")
    else:
        step_id = f"s{index + 1}"

    if kind == "action":
        act = str(s.get("act", "")).strip()
        if act not in ACTIONS:
            raise err("INVALID_STEP", f"{where}: act 非法 {act!r}（白名单 {sorted(ACTIONS)}）")
        target = validate_target_spec(substitute(s.get("target"), variables, f"{where}.target"), f"{where}.target")
        if act in NEED_TARGET and target.get("kind") == "none":
            raise err("INVALID_STEP", f"{where}: 动作 {act} 需要 target")
        if act in NEED_VALUE and s.get("value") is None:
            raise err("INVALID_STEP", f"{where}: 动作 {act} 需要 value")
        value = substitute(s.get("value"), variables, f"{where}.value") if s.get("value") is not None else None
        expect = validate_expects(substitute(s.get("expect"), variables, f"{where}.expect"), f"{where}.expect") \
            if s.get("expect") is not None else []
        return {"id": step_id, "kind": "action", "act": act, "target": target, "value": value, "expect": expect}

    if kind == "wait":
        mode = str(s.get("mode", "time")).strip()
        if mode not in WAIT_MODES:
            raise err("INVALID_STEP", f"{where}: wait.mode 非法 {mode!r}（{sorted(WAIT_MODES)}）")
        timeout = s.get("timeoutMs")
        if timeout is not None:
            try:
                timeout = int(timeout)
            except (TypeError, ValueError):
                raise err("INVALID_STEP", f"{where}: wait.timeoutMs 必须是整数")
        target = validate_target_spec(substitute(s.get("target"), variables, f"{where}.target"), f"{where}.target")
        text = substitute(s.get("text"), variables, f"{where}.text") if s.get("text") is not None else None
        if mode == "element" and target.get("kind") == "none":
            raise err("INVALID_STEP", f"{where}: wait mode=element 需要 target")
        if mode == "text" and not text:
            raise err("INVALID_STEP", f"{where}: wait mode=text 需要 text")
        if mode == "time":
            ms = s.get("ms")
            if ms is None:
                raise err("INVALID_STEP", f"{where}: wait mode=time 需要 ms")
            try:
                ms = int(ms)
            except (TypeError, ValueError):
                raise err("INVALID_STEP", f"{where}: wait.ms 必须是整数")
            ms = max(0, ms)
            return {"id": step_id, "kind": "wait", "mode": "time", "ms": ms,
                    "timeoutMs": min(timeout, 30000) if timeout else None}
        return {"id": step_id, "kind": "wait", "mode": mode, "target": target, "text": text, "timeoutMs": timeout}

    if kind == "screenshot":
        return {"id": step_id, "kind": "screenshot", "saveAs": s.get("saveAs")}

    if kind == "extract":
        target = validate_target_spec(substitute(s.get("target"), variables, f"{where}.target"), f"{where}.target")
        if target.get("kind") == "none":
            raise err("INVALID_STEP", f"{where}: extract 需要 target")
        fields = s.get("fields") or ["text"]
        if not isinstance(fields, list) or not fields or any(f not in EXTRACT_FIELDS for f in fields):
            raise err("INVALID_STEP", f"{where}: extract.fields 非法（{sorted(EXTRACT_FIELDS)}）")
        save_as = s.get("saveAs")
        if not save_as or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", str(save_as)):
            raise err("INVALID_STEP", f"{where}: extract.saveAs 必须是合法变量名")
        return {"id": step_id, "kind": "extract", "target": target, "fields": fields, "saveAs": str(save_as)}

    if kind == "assert":
        op = str(s.get("op", "")).strip()
        if op not in ASSERT_OPS:
            raise err("INVALID_STEP", f"{where}: assert.op 非法 {op!r}（{sorted(ASSERT_OPS)}）")
        spec: dict = {"id": step_id, "kind": "assert", "op": op}
        if op in ("var_equals", "var_contains"):
            name = s.get("name")
            if not name:
                raise err("INVALID_STEP", f"{where}: assert {op} 需要 name")
            if op == "var_equals" and "value" not in s:
                raise err("INVALID_STEP", f"{where}: assert var_equals 需要 value")
            spec["name"] = str(name)
            spec["value"] = substitute(s.get("value"), variables, f"{where}.value")
        elif op in ("element_exists", "element_gone"):
            spec["target"] = validate_target_spec(substitute(s.get("target"), variables, f"{where}.target"), f"{where}.target")
        elif op == "window_title_contains":
            if not s.get("value"):
                raise err("INVALID_STEP", f"{where}: assert window_title_contains 需要 value")
            spec["value"] = str(s.get("value"))
        elif op == "var_exists":
            if not s.get("name"):
                raise err("INVALID_STEP", f"{where}: assert var_exists 需要 name")
            spec["name"] = str(s.get("name"))
        return spec

    # goal：execute 内唯一语义步骤
    goal = substitute(s.get("goal"), variables, f"{where}.goal")
    if not goal or not str(goal).strip():
        raise err("INVALID_STEP", f"{where}: goal 步骤需要非空 goal 文本")
    value = substitute(s.get("value"), variables, f"{where}.value") if s.get("value") is not None else None
    expect = validate_expects(substitute(s.get("expect"), variables, f"{where}.expect"), f"{where}.expect") \
        if s.get("expect") is not None else []
    return {"id": step_id, "kind": "goal", "goal": str(goal).strip(), "value": value, "expect": expect}


def validate_expects(raw, where: str) -> list[dict]:
    if not isinstance(raw, list):
        raise err("INVALID_STEP", f"{where} 必须是数组")
    from .targeting import validate_target_spec
    out: list[dict] = []
    for i, e in enumerate(raw):
        w = f"{where}[{i}]"
        if not isinstance(e, dict):
            raise err("INVALID_STEP", f"{w}: expect 项必须是对象")
        k = e.get("kind")
        if k not in EXPECT_KINDS:
            raise err("INVALID_STEP", f"{w}: expect.kind 非法 {k!r}（{sorted(EXPECT_KINDS)}）")
        item: dict = {"kind": k}
        if k in ("element_exists", "element_gone"):
            item["target"] = validate_target_spec(e.get("target"), f"{w}.target")
            if item["target"].get("kind") == "none":
                raise err("INVALID_STEP", f"{w}: expect {k} 需要 target")
        elif k == "text_present":
            if not e.get("text"):
                raise err("INVALID_STEP", f"{w}: expect text_present 需要 text")
            item["text"] = str(e["text"])
        elif k == "window_title_contains":
            if not e.get("value"):
                raise err("INVALID_STEP", f"{w}: expect window_title_contains 需要 value")
            item["value"] = str(e["value"])
        if e.get("timeoutMs") is not None:
            try:
                item["timeoutMs"] = int(e["timeoutMs"])
            except (TypeError, ValueError):
                raise err("INVALID_STEP", f"{w}: expect.timeoutMs 必须是整数")
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# run 模式规划轮（1-3 步，DESIGN ADR-04 / §7）
# ---------------------------------------------------------------------------

PLANNER_STEP_KINDS = {"action", "wait", "screenshot", "extract", "goal"}


def validate_plan_round(raw, *, max_steps: int = 3) -> dict:
    """规划器单轮输出：{"analysis": str, "done": bool, "steps": [≤3 步]}。"""
    if not isinstance(raw, dict):
        raise err("INVALID_STEP", "规划输出必须是 JSON 对象")
    done = raw.get("done")
    if not isinstance(done, bool):
        raise err("INVALID_STEP", "规划输出缺少布尔 done 字段")
    analysis = str(raw.get("analysis", "")).strip()
    steps_raw = raw.get("steps", [])
    if not isinstance(steps_raw, list):
        raise err("INVALID_STEP", "规划输出 steps 必须是数组")
    if len(steps_raw) > max_steps:
        raise err("INVALID_STEP", f"单轮规划最多 {max_steps} 步，得到 {len(steps_raw)}")
    if done and len(steps_raw) > 0:
        raise err("INVALID_STEP", "done=true 时 steps 必须为空数组")
    if not done and len(steps_raw) == 0:
        raise err("INVALID_STEP", "done=false 时必须给出至少 1 步")
    steps = []
    for i, s in enumerate(steps_raw):
        if isinstance(s, dict) and s.get("kind") == "assert":
            raise err("INVALID_STEP", "规划轮不允许 assert 步骤（断言由引擎完成）")
        if isinstance(s, dict) and s.get("kind") not in PLANNER_STEP_KINDS:
            raise err("INVALID_STEP", f"规划步骤 kind 非法: {s.get('kind')!r}（{sorted(PLANNER_STEP_KINDS)}）")
        steps.append(validate_step(s, where=f"plan.steps[{i}]", index=i, variables={}))
    return {"analysis": analysis, "done": done, "steps": steps}
