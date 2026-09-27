"""run 引擎（DESIGN ADR-04 / §7）：完整目标 → 规划 LLM 有界 ReAct。

每轮：紧凑观察 → 规划 1-3 步（严格 JSON，一次修复重试）→ 执行 → 代码断言 + Jev 校验。
done 判定三重：规划器 done 标志 + Jev Noul(done) + success_criteria 逐条 Noul。
规划器反复误报完成（≥3 次）即失败，不无限循环。
"""

from . import winapi
from .envelope import check_cancel
from .errors import JevError, err
from .executor import ExecuteEngine
from .observe import take_snapshot
from .planner import Planner
from .targeting import select_window_with_jev

MAX_FALSE_DONE = 3
DONE_CONFIRM_AT = 0.80
VERIFY_TIMEOUT_S = 45.0


class RunEngine:
    def __init__(self, ctx):
        self.ctx = ctx

    def run(self, *, goal: str, criteria: list[str] | None, values: dict | None,
            window, budget, session_window: dict | None = None) -> dict:
        ctx = self.ctx
        cfg = ctx.cfg
        jev = ctx.jev_required()
        planner = Planner(cfg, ctx.metrics, env=ctx.env)
        if not planner.available():
            raise err("PLANNER_NOT_CONFIGURED",
                      "run 模式需要规划 LLM：配置 planner.baseUrl/model 并在环境变量提供密钥"
                      "（execute 不依赖规划器）")
        criteria = [str(c) for c in (criteria or []) if str(c).strip()]

        # 目标窗口（Jev 消歧）
        win = window
        if win is None or not win.hwnd:
            hwnd = ctx.resolve_default_window()
            if hwnd:
                win = ctx.window_info(hwnd)
        if win is not None and (ctx.args_app or ctx.args_title or ctx.args_window_id):
            win = select_window_with_jev(ctx.args_app, ctx.args_title, ctx.args_window_id, jev,
                                         session_window=session_window)

        engine = ExecuteEngine(ctx)
        recent: list[dict] = []
        rounds = 0
        false_done = 0
        last_snapshot_text = ""
        artifacts: list[str] = []
        while True:
            check_cancel(ctx.cancel)
            budget.check_deadline("run")
            budget.take_planner(planner.count)
            budget.take_jev(jev.count)
            rounds += 1

            # 1) 观察（紧凑文本；uia 优先，失败落 ocr）
            snap = self._observe_safe(win)
            if snap is not None:
                last_snapshot_text = snap.text
                if snap.image_path:
                    artifacts.append(snap.image_path)
                if win is None and snap.window.get("hwnd"):
                    win = ctx.window_info(snap.window["hwnd"])

            # 2) 规划（1-3 步）
            try:
                plan = planner.plan_round(
                    goal=goal, criteria=criteria, snapshot_text=last_snapshot_text,
                    window={"title": win.title if win else None, "process": win.process if win else None},
                    recent=recent,
                    budget_note=(f"剩余 {budget.remaining_ms()}ms；已 {rounds} 轮；"
                                 f"规划/判断请求 {planner.count}/{jev.count}"),
                    timeout_s=min(60.0, max(15.0, budget.remaining_ms() / 1000)))
            except JevError as e:
                if e.code == "PROVIDER_ERROR":
                    e.details = {**(e.details or {}), "rounds": rounds}
                raise

            if plan["done"]:
                verdict = self._verify(goal, criteria, win, jev)
                if verdict["done"]:
                    return self._success(goal, criteria, rounds, recent, artifacts, verdict, plan)
                false_done += 1
                recent.append({"round": rounds, "plannerSaysDone": True, "verified": False,
                               "probabilities": verdict["probabilities"],
                               "note": "规划器判断完成但验收未通过"})
                if false_done >= MAX_FALSE_DONE:
                    raise err("PROVIDER_ERROR",
                              f"规划器连续 {false_done} 次误报完成而验收未通过；请补充 success_criteria 或改用 execute 分步执行",
                              details={"probabilities": verdict["probabilities"], "rounds": rounds})
                continue

            # 3) 执行本轮步骤（复用 execute 引擎；失败不中断，交还规划器）
            budget.check_step(rounds * 3)
            outcome = engine.run(steps=plan["steps"], values=values, stop_on_error=False,
                                 budget=budget, window=win)
            step_results = outcome.get("results", [])
            artifacts.extend(outcome.get("artifacts", []))
            failed_steps = [r for r in step_results if not r.get("ok")]
            recent.append({
                "round": rounds,
                "analysis": plan["analysis"],
                "steps": [{"act": s.get("act") or s.get("kind"), "ok": s.get("ok"),
                           "error": (s.get("error") or {}).get("code") if not s.get("ok") else None}
                          for s in step_results],
                "failed": bool(failed_steps),
            })
            ctx.metrics.steps += len(step_results)

            # 4) 步后 Jev 校验（done/blocked 并行独立问题）
            if win is not None and not failed_steps:
                check_cancel(ctx.cancel)
                budget.take_jev(jev.count)
                snap2 = self._observe_safe(win)
                if snap2 is not None:
                    last_snapshot_text = snap2.text
                    verdicts = jev.noul_batch(
                        state={"goal": goal, "criteria": criteria, "snapshot": snap2.text[:4000],
                               "recentRounds": recent[-3:]},
                        questions={"done": f"当前界面是否表明目标已完成：「{goal}」？",
                                   "blocked": "界面是否被登录墙/验证码/权限弹窗阻塞？"})
                    if verdicts.get("blocked", 0) >= cfg["jev"]["blockedAt"]:
                        raise err("GOAL_BLOCKED",
                                  "任务被界面阻塞（登录墙/验证码/权限弹窗）；请人工处理后重试",
                                  details={"probabilities": verdicts, "rounds": rounds})
                    if verdicts.get("done", 0) >= DONE_CONFIRM_AT:
                        final = self._verify(goal, criteria, win, jev)
                        if final["done"] or verdicts.get("done", 0) >= cfg["jev"]["doneAt"]:
                            return self._success(goal, criteria, rounds, recent, artifacts, final, plan)
            if budget.remaining_ms() <= 0:
                raise err("BUDGET_EXCEEDED",
                          f"run 超出时间预算（{budget.run_timeout_ms}ms），已完成 {rounds} 轮；"
                          "结果以最后快照为准（动作已派发，不代表未生效）",
                          details={"rounds": rounds, "recent": recent[-2:]})

    # ------------------------------------------------------------------

    def _observe_safe(self, win):
        ctx = self.ctx
        if win is None or not win.hwnd:
            return None
        try:
            return take_snapshot(ctx, win.hwnd, win)
        except JevError as e:
            if e.code in ("UIA_UNAVAILABLE", "WINDOW_LOST", "OCR_UNAVAILABLE"):
                return None
            raise

    def _verify(self, goal: str, criteria: list[str], win, jev) -> dict:
        """完成校验：done Noul + criteria 逐条 Noul（独立问题合并一次请求）。"""
        ctx = self.ctx
        budget = ctx.budget
        budget.take_jev(jev.count)
        snap = self._observe_safe(win)
        state = {
            "goal": goal,
            "criteria": criteria,
            "snapshot": (snap.text[:4000] if snap else "（观察失败）"),
        }
        questions = {"done": f"当前界面是否表明目标已完成：「{goal}」？"}
        for i, c in enumerate(criteria):
            questions[f"crit{i}"] = f"验收条件是否满足：「{c}」？"
        verdicts = jev.noul_batch(state=state, questions=questions, timeout_s=VERIFY_TIMEOUT_S)
        done = verdicts.get("done", 0) >= ctx.cfg["jev"]["doneAt"]
        if criteria:
            crit_ok = all(verdicts.get(f"crit{i}", 0) >= ctx.cfg["jev"]["doneAt"] for i in range(len(criteria)))
            done = done and crit_ok
        return {"done": done, "probabilities": verdicts, "criteriaCount": len(criteria),
                "criteriaNote": "未配置 success_criteria，按『完成目标的直接可观察结果』验收" if not criteria else ""}

    def _success(self, goal, criteria, rounds, recent, artifacts, verdict, plan) -> dict:
        return {
            "__engine": True,
            "goal": goal,
            "rounds": rounds,
            "verified": True,
            "probabilities": verdict.get("probabilities", {}),
            "criteriaNote": verdict.get("criteriaNote", ""),
            "analysis": plan.get("analysis", ""),
            "recent": recent,
            "artifacts": artifacts,
        }
