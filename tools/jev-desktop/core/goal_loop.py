"""goal 步骤的 Jev 局部循环（DESIGN §6/§8）：观察→选择→动作→校验，有界。

execute 的 goal 步骤与 run 的单轮执行共用本循环。Jev 只做闭集选择与是/否判断（ADR-02）。
"""

import time

from . import winapi
from .act import perform as perform_action
from .envelope import check_cancel
from .errors import JevError, err
from .observe import take_snapshot
from .targeting import build_candidates, resolve_ref
from .targeting import ResolvedTarget

GOAL_ACTS = ["click", "type", "set_value", "press", "scroll", "select", "wait", "none"]

ACT_DESC = {
    "click": "点击目标元素（按钮/链接/菜单项/勾选）",
    "type": "向目标文本框输入 value 文本（追加，不清空）",
    "set_value": "把目标输入框的值整体设置为 value 文本",
    "press": "在目标上按 value 键组合（如 enter、ctrl+s）",
    "scroll": "滚动以显示更多内容",
    "select": "在目标下拉/列表中选择 value 选项",
    "wait": "等待界面处理（按钮转圈/加载中）",
    "none": "无需动作：目标已达成或本界面无法推进",
}

DEFAULT_MAX_ROUNDS = 6


def goal_loop(ctx, *, goal: str, value: str | None, window, budget, expect=None,
              variables: dict | None = None, max_rounds: int = DEFAULT_MAX_ROUNDS,
              success_hint: str | None = None) -> dict:
    """执行一个语义目标；返回 {ok, rounds, used:[...], note}。"""
    jev = ctx.jev_required()
    hwnd = window.hwnd if window else ctx.resolve_default_window()
    if not hwnd:
        raise err("APP_NOT_FOUND", f"语义目标 \"{goal}\" 需要目标窗口")
    rounds = 0
    used: list[str] = []
    last_probs: dict = {}
    consecutive_none = 0
    while rounds < max_rounds:
        check_cancel(ctx.cancel)
        budget.check_deadline("goal 步骤")
        budget.take_jev(jev.count)
        rounds += 1
        win_info = ctx.window_info(hwnd)
        snap = take_snapshot(ctx, hwnd, win_info)
        candidates, labels = build_candidates(snap)
        if not candidates:
            raise err("TARGET_NOT_FOUND",
                      f"目标窗口没有任何可交互候选，无法推进语义目标 \"{goal}\"；"
                      "可尝试 level=ocr/vlm 观察")
        questions = {
            "done": f"当前界面状态是否表明目标已达成：「{goal}」？",
            "blocked": f"界面是否被登录墙、验证码、权限弹窗等阻塞，导致无法推进「{goal}」？",
            "error": "界面是否显示了错误信息（如操作失败、输入错误）？",
        }
        if success_hint:
            questions["done"] += f"（达成标志：{success_hint}）"
        verdicts = jev.noul_batch(state=_state(ctx, goal, snap, value, used, variables), questions=questions)
        last_probs = verdicts
        if verdicts.get("done", 0) >= ctx.cfg["jev"]["doneAt"]:
            if expect:
                from .executor import ExecuteEngine
                ExecuteEngine(ctx)._check_expect(expect, variables or {}, window, budget)
            return {"ok": True, "rounds": rounds, "used": used, "note": f"Jev 校验通过（{verdicts}）",
                    "probabilities": verdicts}
        if verdicts.get("blocked", 0) >= ctx.cfg["jev"]["blockedAt"]:
            raise err("GOAL_BLOCKED", f"推进「{goal}」被界面阻塞（登录墙/弹窗/验证码）；请人工处理后重试",
                      details={"probabilities": verdicts})
        # 选择动作与目标
        state = _state(ctx, goal, snap, value, used, variables)
        act_idx, act_probs = jev.choice(
            state=state, question="为了推进目标，下一步执行哪个动作？",
            candidates=[f"{a}：{ACT_DESC[a]}" for a in GOAL_ACTS],
            instructions=goal, qid="act")
        act = GOAL_ACTS[act_idx] if act_idx is not None else "none"
        last_probs.update({f"act.{k}": v for k, v in act_probs.items()})
        if act in ("none", "wait"):
            if act == "wait":
                time.sleep(0.8)
                used.append("wait")
                continue
            consecutive_none += 1
            if consecutive_none >= 2:
                raise err("GOAL_BLOCKED",
                          f"Jev 连续判断无法推进「{goal}」（当前界面没有可推进的候选）；"
                          "请重新描述目标、更换窗口或人工处理",
                          details={"probabilities": last_probs})
            continue
        consecutive_none = 0
        tgt_idx, tgt_probs = jev.choice(
            state=state, question=f"执行 {act} 应作用于哪个候选？",
            candidates=labels, instructions=goal, qid="target")
        last_probs.update({f"target.{k}": v for k, v in tgt_probs.items()})
        conf = max(tgt_probs.values()) if tgt_probs else 0.0
        if tgt_idx is None:
            raise err("TARGET_NOT_FOUND", f"Jev 判断无候选可承载动作 {act}（目标「{goal}」）；请重新快照或调整目标",
                      details={"probabilities": last_probs})
        if conf < ctx.cfg["jev"]["confidenceAt"]:
            raise err("AMBIGUOUS_TARGET",
                      f"动作 {act} 的目标选择置信度低（{conf:.2f} < {ctx.cfg['jev']['confidenceAt']}）；"
                      "请用 ref 精确定位或重新快照",
                      details={"probabilities": tgt_probs})
        # 动作需要 value 而未提供
        act_value = value
        if act in ("type", "set_value", "press", "select") and not act_value:
            raise err("INVALID_STEP",
                      f"goal 步骤选择的动作 {act} 需要 value（要输入的文本/按键/选项），"
                      "请在步骤中提供 value 或改写 goal 描述")
        chosen = candidates[tgt_idx]
        target: ResolvedTarget
        if chosen[0] == "uia":
            target = resolve_ref(ctx, chosen[2].ref)
        else:
            cur = winapi.window_rect(hwnd) or (0, 0, 0, 0)
            pt = (cur[0] + chosen[2].rel_center[0], cur[1] + chosen[2].rel_center[1])
            target = ResolvedTarget(kind="point", hwnd=hwnd, point=pt, center_point=pt,
                                    summary=f"文字块 \"{chosen[2].text[:30]}\"")
        try:
            perform_action(ctx, act, target, value=act_value)
        except JevError as e:
            if e.code == "INVALID_PARAMS" and act in ("type", "set_value"):
                raise err("INVALID_STEP", f"goal「{goal}」选择的动作 {act} 需要 value 参数；请在步骤里提供 value")
            raise
        ctx.metrics.actions += 1
        used.append(f"{act}({target.describe()[:60]})")
        ctx.ledger.record(tool="goal", action=act, target=target.describe(), value=act_value,
                          outcome="ok", session=ctx.session_id)
        time.sleep(0.3)  # UI 稳定
    raise err("GOAL_BLOCKED",
              f"语义目标「{goal}」在 {max_rounds} 轮内未达成（Jev 校验未通过）；"
              "可提高 maxRounds、拆分目标或改用 ref 精确步骤",
              details={"probabilities": last_probs, "used": used})


def _state(ctx, goal: str, snap, value: str | None, used: list[str], variables: dict | None) -> dict:
    return {
        "goal": goal,
        "level": snap.level,
        "window": {"title": snap.window.get("title"), "pid": snap.window.get("pid")},
        "snapshotText": snap.text[:4000],
        "providedValue": value if value else None,
        "recentActions": used[-5:],
        "variables": sorted((variables or {}).keys()),
    }
