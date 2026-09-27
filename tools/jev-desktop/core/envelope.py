"""统一 envelope（DESIGN §9）与预算控制。"""

import json
import time

from .errors import CancelledSignal, JevError, err

SCHEMA_VERSION = 1


def envelope(status: str, *, result=None, steps=None, evidence=None, metrics=None, error=None) -> dict:
    out: dict = {"schemaVersion": SCHEMA_VERSION, "status": status}
    if result is not None:
        out["result"] = result
    if steps is not None:
        out["steps"] = steps
    if evidence is not None:
        out["evidence"] = evidence
    if metrics is not None:
        out["metrics"] = metrics
    out["error"] = error
    return out


def failed(err_: JevError, *, result=None, steps=None, evidence=None, metrics=None) -> dict:
    return envelope("failed", result=result, steps=steps, evidence=evidence, metrics=metrics, error=err_.to_dict())


def cancelled(*, result=None, steps=None, evidence=None, metrics=None) -> dict:
    return envelope("cancelled", result=result, steps=steps, evidence=evidence, metrics=metrics)


def dumps(envelope_dict: dict, *, indent: int | None = 2) -> str:
    return json.dumps(envelope_dict, ensure_ascii=False, indent=indent, default=str)


class Metrics:
    """用量统计：token 缺失记 unknown，不当作零（DESIGN §9）。"""

    def __init__(self) -> None:
        self.steps = 0
        self.actions = 0
        self.jev_requests = 0
        self.planner_requests = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.input_unknown = False
        self.output_unknown = False
        self.t0 = time.monotonic()

    def add_tokens(self, usage: dict | None) -> None:
        if not isinstance(usage, dict):
            self.input_unknown = self.output_unknown = True
            return
        it, ot = usage.get("input_tokens"), usage.get("output_tokens")
        if isinstance(it, (int, float)):
            self.input_tokens += int(it)
        else:
            self.input_unknown = True
        if isinstance(ot, (int, float)):
            self.output_tokens += int(ot)
        else:
            self.output_unknown = True

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self.t0) * 1000)

    def to_dict(self) -> dict:
        tokens: dict = {"input": self.input_tokens, "output": self.output_tokens}
        if self.input_unknown:
            tokens["inputUnknown"] = True
        if self.output_unknown:
            tokens["outputUnknown"] = True
        return {
            "steps": self.steps,
            "actions": self.actions,
            "jevRequests": self.jev_requests,
            "plannerRequests": self.planner_requests,
            "tokens": tokens,
            "elapsedMs": self.elapsed_ms(),
        }


class Budget:
    """预算（DESIGN §9）：任务只可缩短全局默认；超限抛 BUDGET_EXCEEDED / TIMEOUT。"""

    def __init__(self, cfg: dict, *, run_timeout_ms: int | None = None):
        rt = cfg["runtime"]
        self.run_timeout_ms = min(run_timeout_ms, rt["runTimeoutMs"]) if run_timeout_ms else rt["runTimeoutMs"]
        self.act_timeout_ms = rt["actTimeoutMs"]
        self.snapshot_timeout_ms = rt["snapshotTimeoutMs"]
        self.wait_max_ms = rt["waitMaxMs"]
        self.max_steps = rt["maxSteps"]
        self.max_planner_requests = rt["maxPlannerRequests"]
        self.max_jev_requests = rt["maxJevRequests"]
        self.max_input_tokens = rt["maxInputTokens"]
        self.max_output_tokens = rt["maxOutputTokens"]
        self._start = time.monotonic()

    def remaining_ms(self) -> int:
        return max(0, self.run_timeout_ms - int((time.monotonic() - self._start) * 1000))

    def check_deadline(self, what: str = "任务") -> None:
        if self.run_timeout_ms and self.remaining_ms() <= 0:
            raise err("BUDGET_EXCEEDED", f"{what}超出 runTimeoutMs 预算（{self.run_timeout_ms}ms）")

    def check_step(self, done_steps: int) -> None:
        if done_steps >= self.max_steps:
            raise err("BUDGET_EXCEEDED", f"步骤数达到上限 maxSteps={self.max_steps}")

    def take_planner(self, used: int) -> None:
        if used >= self.max_planner_requests:
            raise err("BUDGET_EXCEEDED", f"规划请求数达到上限 maxPlannerRequests={self.max_planner_requests}")

    def take_jev(self, used: int) -> None:
        if used >= self.max_jev_requests:
            raise err("BUDGET_EXCEEDED", f"Jev 请求数达到上限 maxJevRequests={self.max_jev_requests}")


def check_cancel(cancel=None) -> None:
    if cancel is not None and cancel.is_set():
        raise CancelledSignal()
