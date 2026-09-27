"""Jev 判断客户端（DESIGN §6 / ADR-02）：TypeSafe SystemOne 协议（POST {baseUrl}/v1/systemone）。

- 只做闭集选择（Choice）与是/否判断（Noul），不生成自由文本；
- 一次请求只问相互独立的问题（上游规范）；
- key 一律经环境变量（apiKeyEnv），重试收口在此（429/5xx/网络错误一次退避重试）；
- usage 缺失记 unknown，不当作零。
经薄 httpx 适配统一支持 bocha/typesafe/vercel/zen/custom 预设（协议同构，DESIGN §6.1）。
"""

import time

import httpx

from .errors import JevError, err
from .envelope import Metrics

MAX_CANDIDATES = 200  # 自限留余量（DESIGN §6）


class JevClient:
    def __init__(self, cfg: dict, metrics: Metrics, env: dict | None = None):
        import os
        self.cfg = cfg["jev"]
        self.metrics = metrics
        env = os.environ if env is None else env
        key = env.get(self.cfg["apiKeyEnv"], "")
        self.api_key: str | None = key or None
        self.count = 0

    def available(self) -> bool:
        return bool(self.api_key)

    def _require(self) -> str:
        if not self.api_key:
            raise err("PROVIDER_ERROR",
                      f"缺少 Jev API key（环境变量 {self.cfg['apiKeyEnv']}）；"
                      "确定性步骤（execute 的 action/wait 等）不需要它",
                      details={"provider": self.cfg["provider"], "baseUrl": self.cfg["baseUrl"]})
        return self.api_key

    # ------------------------------------------------------------------

    def _post(self, state: dict, questions: dict, timeout_s: float) -> dict:
        key = self._require()
        self.count += 1
        self.metrics.jev_requests += 1
        body = {"state": state, "model": self.cfg["model"], "questions": questions}
        url = self.cfg["baseUrl"].rstrip("/") + "/v1/systemone"
        headers = {"authorization": f"Bearer {key}", "content-type": "application/json"}
        last: Exception | None = None
        for attempt in range(2):  # 重试收口：最多一次退避重试
            try:
                resp = httpx.post(url, json=body, headers=headers, timeout=timeout_s)
                if resp.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                    time.sleep(0.8)
                    continue
                if resp.status_code != 200:
                    raise err("PROVIDER_ERROR", f"Jev 端点 {resp.status_code}: {resp.text[:200]}",
                              retryable=resp.status_code in (429, 502, 503, 504))
                try:
                    data = resp.json()
                except ValueError as e:
                    raise err("PROVIDER_ERROR", f"Jev 响应不是合法 JSON: {e}", retryable=True)
                self.metrics.add_tokens(data.get("usage") or {})
                return data
            except httpx.HTTPError as e:
                last = e
                if attempt == 0:
                    time.sleep(0.8)
                    continue
                break
            except JevError:
                raise
        raise err("PROVIDER_ERROR", f"Jev 请求失败（重试后）: {type(last).__name__}: {last}", retryable=True)

    # ------------------------------------------------------------------

    def choice(self, *, state: dict, question: str, candidates: list[str],
               instructions: str | None = None, qid: str = "choice") -> tuple[int | None, dict]:
        """闭集选择：候选 = criteria（自动带 none 项）。返回 (索引|None, 概率分布)。"""
        if len(candidates) > MAX_CANDIDATES:
            raise err("INTERNAL_ERROR", f"Jev Choice 候选数 {len(candidates)} 超过自限 {MAX_CANDIDATES}")
        criteria = {"none": "没有匹配目标的候选"}
        for i, c in enumerate(candidates):
            criteria[f"c{i}"] = c
        questions = {
            qid: {
                "type": "choice",
                "instructions": {"question": question, **({"goal": instructions} if instructions else {})},
                "criteria": criteria,
            }
        }
        data = self._post(state, questions, timeout_s=45.0)
        answers = data.get("answers") or {}
        ans = answers.get(qid) or {}
        raw = str(ans.get("choice", "none"))
        probs = ans.get("probabilities") or {}
        idx: int | None = None
        if raw.startswith("c") and raw[1:].isdigit():
            idx = int(raw[1:])
        elif raw.isdigit():
            idx = int(raw)
        if idx is not None and not (0 <= idx < len(candidates)):
            idx = None
        return idx, probs

    def noul_batch(self, *, state: dict, questions: dict[str, str], timeout_s: float = 45.0) -> dict[str, float]:
        """同一 state 上并行问多个独立是/否问题。返回 {问题名: 概率}。"""
        qs = {name: {"type": "noul", "instructions": q} for name, q in questions.items()}
        data = self._post(state, qs, timeout_s)
        answers = data.get("answers") or {}
        out: dict[str, float] = {}
        for name in questions:
            ans = answers.get(name) or {}
            try:
                out[name] = float(ans.get("noul", 0))
            except (TypeError, ValueError):
                out[name] = 0.0
        return out

    def choice_index_from(self, answers: dict, qid: str, total: int) -> int | None:
        ans = answers.get(qid) or {}
        raw = str(ans.get("choice", "none"))
        idx: int | None = None
        if raw.startswith("c") and raw[1:].isdigit():
            idx = int(raw[1:])
        elif raw.isdigit():
            idx = int(raw)
        if idx is not None and not (0 <= idx < total):
            return None
        return idx
