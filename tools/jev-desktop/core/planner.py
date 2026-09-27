"""规划器（DESIGN §7）：OpenAI 兼容 /chat/completions，run 模式每轮出 1-3 步严格 JSON。

- 输出经 steps.validate_plan_round 严格校验；校验失败最多一次修复请求；
- 不放宽预算；未配置时 run 返回 PLANNER_NOT_CONFIGURED（不猜模型/供应商）；
- 规划器只见紧凑文本观察（vlm 档才见图），控 token。
"""

import json
import re

import httpx

from .errors import err
from .steps import validate_plan_round

MAX_ROUNDS_STEPS = 3


def planner_configured(cfg: dict, env: dict | None = None) -> bool:
    import os
    env = os.environ if env is None else env
    p = cfg["planner"]
    return bool(p.get("baseUrl") and p.get("model") and env.get(p.get("apiKeyEnv") or ""))


def planner_unconfigured_error(cfg: dict):
    p = cfg["planner"]
    return err("PLANNER_NOT_CONFIGURED",
               "run 模式需要规划 LLM：请在配置中设置 planner.baseUrl / planner.model，"
               f"并在环境变量 {p.get('apiKeyEnv')} 提供密钥（execute 模式不依赖规划器）",
               details={"example": {"planner": {"baseUrl": "https://api.deepseek.com/v1",
                                                "model": "deepseek-chat",
                                                "apiKeyEnv": p.get("apiKeyEnv")}}})


SYSTEM_PROMPT = """你是 Windows 桌面自动化任务规划器。根据目标、当前屏幕快照与最近动作，输出严格 JSON（不要多余文字）：
{"analysis":"一句话分析当前状态","done":布尔,"steps":[1-3个步骤]}
- done=true 表示目标已完成（必须非常有把握；steps 为空数组）
- 步骤 kind 只能是 action|wait|goal|screenshot|extract
- action.act ∈ click|double_click|right_click|type|set_value|press|scroll|select|toggle|expand|collapse|focus|invoke|launch|close
- 定位 target 优先用快照中的 ref：{"kind":"ref","ref":"@快照id:eN"}；其次
  {"kind":"uia","controlType":"Button","name":"保存"}；纯语义目标用 {"kind":"text","target":"描述"}
- type/set_value/press/launch 的步骤必须带 value；scroll 的 value 是 down|up|left|right
- 界面被弹窗/对话框阻挡时，先规划处理弹窗的步骤
- 目标完全无法推进时：done=false 且 steps 只给一个 kind=wait 的步骤
规则：不要发明不存在的 ref；不要输出可执行代码；一次只规划当前界面上的下一步（最多 3 步）。"""


class Planner:
    def __init__(self, cfg: dict, metrics, env: dict | None = None):
        import os
        self.cfg = cfg["planner"]
        self.metrics = metrics
        env = os.environ if env is None else env
        key_env = self.cfg.get("apiKeyEnv") or ""
        self.api_key: str | None = env.get(key_env) or None
        self.count = 0

    def available(self) -> bool:
        return bool(self.api_key and self.cfg.get("baseUrl") and self.cfg.get("model"))

    def _require(self) -> str:
        if not self.available():
            raise err("PLANNER_NOT_CONFIGURED",
                      f"规划器未就绪：需要 planner.baseUrl/planner.model 与环境变量 {self.cfg.get('apiKeyEnv')} 的密钥")
        return self.api_key

    def _chat(self, messages: list[dict], *, json_mode: bool, timeout_s: float) -> str:
        key = self._require()
        self.count += 1
        self.metrics.planner_requests += 1
        body: dict = {"model": self.cfg["model"], "messages": messages,
                      "temperature": self.cfg.get("temperature", 0.2),
                      "max_tokens": self.cfg.get("maxTokens", 2048)}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        url = self.cfg["baseUrl"].rstrip("/") + "/chat/completions"
        try:
            resp = httpx.post(url, json=body, timeout=timeout_s,
                              headers={"authorization": f"Bearer {key}", "content-type": "application/json"})
        except httpx.HTTPError as e:
            raise err("PROVIDER_ERROR", f"规划服务请求失败: {type(e).__name__}: {e}", retryable=True)
        if resp.status_code == 400 and json_mode:
            return self._chat(messages, json_mode=False, timeout_s=timeout_s)  # 端点不支持 json mode
        if resp.status_code != 200:
            raise err("PROVIDER_ERROR", f"规划服务 {resp.status_code}: {resp.text[:200]}",
                      retryable=resp.status_code in (429, 500, 502, 503, 504))
        try:
            data = resp.json()
        except ValueError as e:
            raise err("PROVIDER_ERROR", f"规划响应不是合法 JSON: {e}", retryable=True)
        usage = data.get("usage") or {}
        # OpenAI 风格 usage：prompt_tokens/completion_tokens
        norm = {"input_tokens": usage.get("prompt_tokens"), "output_tokens": usage.get("completion_tokens")}
        self.metrics.add_tokens(norm)
        try:
            return data["choices"][0]["message"]["content"] or ""
        except Exception as e:
            raise err("PROVIDER_ERROR", f"规划响应解析失败: {e}")

    def plan_round(self, *, goal: str, criteria: list[str], snapshot_text: str,
                   window: dict, recent: list[dict], budget_note: str,
                   timeout_s: float = 60.0) -> dict:
        user = {
            "goal": goal,
            "successCriteria": criteria or ["完成目标的直接可观察结果（未显式配置验收）"],
            "window": window,
            "snapshot": snapshot_text[:6000],
            "recentRounds": recent[-3:],
            "budget": budget_note,
        }
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ]
        content = self._chat(messages, json_mode=True, timeout_s=timeout_s)
        try:
            parsed = _extract_json(content)
            return validate_plan_round(parsed, max_steps=MAX_ROUNDS_STEPS)
        except Exception as first:
            messages.append({"role": "assistant", "content": content[:4000]})
            messages.append({"role": "user", "content":
                             f"你的输出未通过校验：{first}。请重新只输出符合规则的 JSON "
                             '{"analysis":"...","done":false,"steps":[...]}。'})
            content = self._chat(messages, json_mode=True, timeout_s=timeout_s)
            try:
                parsed = _extract_json(content)
                return validate_plan_round(parsed, max_steps=MAX_ROUNDS_STEPS)
            except Exception as second:
                raise err("PROVIDER_ERROR", f"规划输出两次校验失败: {second}",
                          details={"firstError": str(first)})


def _extract_json(content: str) -> dict:
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", content)
    candidate = fenced.group(1) if fenced else content
    start, end = candidate.find("{"), candidate.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("输出中找不到 JSON 对象")
    return json.loads(candidate[start:end + 1])
