"""本地 mock 服务器：OpenAI 兼容 /chat/completions + TypeSafe /v1/systemone。

用于 run/goal/VLM 的端到端联调测试（不需要真实 key/网络）。特殊标记：
- goal/问题文本含 "BLOCKED-TEST"：blocked=0.95、done=0.05（验证 GOAL_BLOCKED 路径）
- 消息含 "BADJSON-TEST"：chat 永远返回非法 JSON（验证规划校验失败 → PROVIDER_ERROR）
- 消息含 "VISION-TEST"：chat 返回合法 VLM elements JSON（验证 vlm 档解析）
- state 含 "NOTDONE-TEST"：done 判断恒为 0.05（验证预算耗尽路径）
- state 含 "RETRY-TEST"：第一次请求返回 429，之后 200（验证重试收口）

启动：python tests/mock_server.py <port>
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = {"rounds": 0, "retry_hits": 0}

TOKEN_RE = re.compile(r"[A-Za-z\u4e00-\u9fff]{2,}")


def _pick_choice(body: dict, qid: str, q: dict) -> dict:
    """按 goal/question 与候选文本的词面重叠选候选（比固定第一个更接近真实判断）。"""
    criteria = q.get("criteria") or {}
    keys = [k for k in criteria if k != "none"]
    if not keys:
        return {"choice": "none", "probabilities": {"none": 1.0}}
    state = body.get("state") or {}
    instr = q.get("instructions")
    text = json.dumps(instr, ensure_ascii=False) if not isinstance(instr, str) else instr
    hay = " ".join([str(state.get("goal", "")), text, q.get("instructions") if isinstance(q.get("instructions"), str) else ""])
    tokens = set(TOKEN_RE.findall(hay.lower()))
    best, best_score = None, -1
    for k in keys:
        label = str(criteria[k]).lower()
        score = sum(1 for t in tokens if t in label)
        if k == "none":
            score -= 1
        if score > best_score:
            best, best_score = k, score
    if best is None or best_score < 0:
        best = "none"
    n = max(1, len(criteria))
    others = (1.0 - 0.9) / max(1, n - 1)
    probs = {k: (0.9 if k == best else others) for k in criteria}
    return {"choice": best, "probabilities": probs}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默
        pass

    def _json(self, code, obj):
        payload = obj if isinstance(obj, (dict, list)) else str(obj)
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if not isinstance(obj, str) else obj.encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except ValueError:
            return self._json(400, {"error": "bad json"})
        auth = self.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or len(auth) < 10:
            return self._json(401, {"error": "unauthorized"})
        raw_text = raw.decode("utf-8", "ignore")

        # 重试测试：每个新会话首次请求 429
        if "RETRY-TEST" in raw_text:
            STATE["retry_hits"] += 1
            if STATE["retry_hits"] % 2 == 1:
                return self._json(429, {"error": "slow down"})

        if self.path.endswith("/chat/completions"):
            messages = body.get("messages") or []
            text = json.dumps(messages, ensure_ascii=False)
            if "BADJSON-TEST" in text:
                return self._json(200, {
                    "choices": [{"message": {"role": "assistant", "content": "这不是JSON{{{}}}"}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                })
            if "VISION-TEST" in text or "image_url" in text:
                # 视觉请求（含 image_url，或显式标记）→ 返回合法 VLM elements JSON
                content = json.dumps({"elements": [
                    {"name": "测试按钮", "type": "button", "bbox": [100, 100, 200, 140], "action": "click"},
                    {"name": "输入框", "type": "input", "bbox": [100, 200, 300, 240], "action": "type"},
                ]}, ensure_ascii=False)
                return self._json(200, {
                    "choices": [{"message": {"role": "assistant", "content": content}}],
                    "usage": {"prompt_tokens": 500, "completion_tokens": 100},
                })
            STATE["rounds"] += 1
            if STATE["rounds"] == 1:
                content = json.dumps({
                    "analysis": "目标窗口已就绪，输入验证命令",
                    "done": False,
                    "steps": [
                        {"id": "p1", "kind": "action", "act": "type",
                         "target": {"kind": "none"}, "value": "echo RUN-OK-MOCK"},
                        {"id": "p2", "kind": "action", "act": "press",
                         "target": {"kind": "none"}, "value": "enter"},
                    ],
                }, ensure_ascii=False)
            else:
                content = json.dumps({"analysis": "验证命令已执行", "done": True, "steps": []},
                                     ensure_ascii=False)
            return self._json(200, {
                "choices": [{"message": {"role": "assistant", "content": content}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50},
            })

        if self.path.endswith("/v1/systemone"):
            questions = body.get("questions") or {}
            state_text = json.dumps(body.get("state") or {}, ensure_ascii=False)
            blocked_mode = "BLOCKED-TEST" in state_text
            answers = {}
            for qid, q in questions.items():
                if q.get("type") == "choice":
                    answers[qid] = _pick_choice(body, qid, q)
                else:
                    if blocked_mode:
                        value = 0.95 if qid == "blocked" else (0.05 if qid == "done" else 0.02)
                    elif "NOTDONE-TEST" in state_text and qid == "done":
                        value = 0.05
                    else:
                        value = {"done": 0.95, "doneConfirm": 0.9}.get(qid, 0.02) if qid in ("done", "blocked", "error", "doneConfirm") else 0.9
                    answers[qid] = {"noul": value, "probabilities": {"true": value, "false": 1 - value}}
            return self._json(200, {"answers": answers,
                                    "usage": {"input_tokens": 200, "output_tokens": 20}})

        return self._json(404, {"error": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"mock server on {port}", file=sys.stderr)
    server.serve_forever()
