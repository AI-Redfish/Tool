"""离线单元测试：config / steps / session / errors / envelope / judge 解析。

运行：python tests/test_core.py（无需真实桌面与网络）
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.config import default_config, load_config, redact_config, credential_present
from core.errors import JevError, err
from core.envelope import Budget, Metrics, envelope, failed
from core.steps import (validate_step, validate_steps, validate_expects,
                        validate_plan_round, substitute)
from core.targeting import validate_target_spec
from core.session import RefRegistry, parse_ref, new_snapshot_id
from core.judge import JevClient


class TestConfig(unittest.TestCase):
    def test_defaults_valid(self):
        cfg = load_config(env={})
        self.assertEqual(cfg["schemaVersion"], 1)
        self.assertEqual(cfg["observation"]["level"], "auto")
        self.assertEqual(cfg["jev"]["provider"], "bocha")
        self.assertEqual(cfg["jev"]["baseUrl"], "https://jev.bocha.cn")
        self.assertEqual(cfg["jev"]["model"], "bocha-jev-v1")
        self.assertEqual(cfg["runtime"]["maxSteps"], 40)

    def test_unknown_field_rejected(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"observation": {"level": "uia", "nope": 1}}, f)
            path = f.name
        try:
            with self.assertRaises(JevError) as cm:
                load_config(file=path, env={})
            self.assertEqual(cm.exception.code, "CONFIG_INVALID")
        finally:
            os.unlink(path)

    def test_env_overrides(self):
        cfg = load_config(env={
            "JEV_DESKTOP_OBS_LEVEL": "ocr",
            "JEV_DESKTOP_MAX_STEPS": "12",
            "JEV_DESKTOP_JEV_PROVIDER": "zen",
            "JEV_DESKTOP_LOG_ACTIONS": "true",
        })
        self.assertEqual(cfg["observation"]["level"], "ocr")
        self.assertEqual(cfg["runtime"]["maxSteps"], 12)
        self.assertEqual(cfg["jev"]["provider"], "zen")
        self.assertTrue(cfg["log"]["actions"])

    def test_env_bad_bool(self):
        with self.assertRaises(JevError):
            load_config(env={"JEV_DESKTOP_LOG_ACTIONS": "yes"})

    def test_env_bad_level(self):
        with self.assertRaises(JevError):
            load_config(env={"JEV_DESKTOP_OBS_LEVEL": "ultra"})

    def test_provider_presets(self):
        cfg = load_config(env={"JEV_DESKTOP_JEV_PROVIDER": "typesafe"})
        self.assertEqual(cfg["jev"]["baseUrl"], "https://api.typesafe.ai")
        self.assertEqual(cfg["jev"]["model"], "jev-latest")

    def test_custom_provider_requires_base(self):
        with self.assertRaises(JevError):
            load_config(env={"JEV_DESKTOP_JEV_PROVIDER": "custom"})
        cfg = load_config(env={"JEV_DESKTOP_JEV_PROVIDER": "custom",
                               "JEV_DESKTOP_JEV_BASE_URL": "https://x.example",
                               "JEV_DESKTOP_JEV_MODEL": "m1"})
        self.assertEqual(cfg["jev"]["baseUrl"], "https://x.example")

    def test_explicit_file_must_exist(self):
        with self.assertRaises(JevError):
            load_config(file="Z:/no/such/file.json", env={})

    def test_redact_no_secrets(self):
        cfg = load_config(env={"JEV_DESKTOP_PLANNER_API_KEY": "sk-secret"})
        r = redact_config(cfg)
        dumped = json.dumps(r)
        self.assertNotIn("sk-secret", dumped)

    def test_credential_present(self):
        cfg = load_config(env={})
        self.assertFalse(credential_present(cfg, "jev", env={}))
        self.assertTrue(credential_present(cfg, "jev", env={"TYPESAFE_API_KEY": "x"}))


class TestTargetSpec(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(validate_target_spec(None), {"kind": "none"})
        self.assertEqual(validate_target_spec("@abc:e3"), {"kind": "ref", "ref": "@abc:e3"})
        self.assertEqual(validate_target_spec("搜索框"), {"kind": "text", "target": "搜索框"})
        spec = validate_target_spec({"kind": "uia", "controlType": "Button", "name": "保存"})
        self.assertEqual(spec["kind"], "uia")
        self.assertEqual(validate_target_spec({"kind": "coords", "x": 5, "y": 6}),
                         {"kind": "coords", "x": 5, "y": 6})
        self.assertEqual(validate_target_spec({"kind": "none"}), {"kind": "none"})

    def test_errors(self):
        for bad in ({"kind": "wat"}, {"kind": "coords"}, {"kind": "uia"},
                    {"kind": "text"}, {"kind": "ref", "ref": "xx"}):
            with self.assertRaises(JevError):
                validate_target_spec(bad)


class TestSteps(unittest.TestCase):
    def test_action_step(self):
        s = validate_step({"kind": "action", "act": "click",
                           "target": {"kind": "ref", "ref": "@abc:e1"}}, where="t", index=0, variables={})
        self.assertEqual(s["id"], "s1")
        self.assertEqual(s["act"], "click")
        self.assertEqual(s["expect"], [])

    def test_action_needs_target(self):
        with self.assertRaises(JevError):
            validate_step({"kind": "action", "act": "click"}, where="t", index=0, variables={})

    def test_action_needs_value(self):
        with self.assertRaises(JevError):
            validate_step({"kind": "action", "act": "type",
                           "target": {"kind": "none"}}, where="t", index=0, variables={})

    def test_variable_substitution(self):
        s = validate_step({"kind": "action", "act": "type", "target": {"kind": "none"},
                           "value": "hi ${name}"},
                          where="t", index=0, variables={"name": "世界"})
        self.assertEqual(s["value"], "hi 世界")
        with self.assertRaises(JevError):
            substitute("${missing}", {}, "x")

    def test_wait_step(self):
        s = validate_step({"kind": "wait", "mode": "time", "ms": "500"}, where="t", index=0, variables={})
        self.assertEqual(s["ms"], 500)
        with self.assertRaises(JevError):
            validate_step({"kind": "wait", "mode": "element"}, where="t", index=0, variables={})

    def test_extract_and_assert(self):
        s = validate_step({"kind": "extract", "target": {"kind": "ref", "ref": "@a:e1"},
                           "fields": ["text"], "saveAs": "out"}, where="t", index=0, variables={})
        self.assertEqual(s["saveAs"], "out")
        with self.assertRaises(JevError):
            validate_step({"kind": "extract", "target": {"kind": "ref", "ref": "@a:e1"},
                           "fields": ["bogus"], "saveAs": "out"}, where="t", index=0, variables={})
        s = validate_step({"kind": "assert", "op": "var_equals", "name": "x", "value": "1"},
                          where="t", index=0, variables={})
        self.assertEqual(s["op"], "var_equals")

    def test_goal_step(self):
        s = validate_step({"kind": "goal", "goal": " 保存文件 "}, where="t", index=0, variables={})
        self.assertEqual(s["goal"], "保存文件")
        with self.assertRaises(JevError):
            validate_step({"kind": "goal", "goal": ""}, where="t", index=0, variables={})

    def test_validate_steps_rejects_empty(self):
        with self.assertRaises(JevError):
            validate_steps([])
        with self.assertRaises(JevError):
            validate_steps("notalist")

    def test_plan_round(self):
        p = validate_plan_round({"analysis": "a", "done": False, "steps": [
            {"kind": "action", "act": "click", "target": {"kind": "ref", "ref": "@a:e1"}}]})
        self.assertEqual(len(p["steps"]), 1)
        with self.assertRaises(JevError):
            validate_plan_round({"done": True, "steps": [{"kind": "wait", "ms": 1}]})
        with self.assertRaises(JevError):
            validate_plan_round({"done": False, "steps": []})
        with self.assertRaises(JevError):
            validate_plan_round({"done": False, "steps": [
                {"kind": "action", "act": "click", "target": {"kind": "ref", "ref": "@a:e1"}}] * 4})


class TestSession(unittest.TestCase):
    def _registry(self, tmp):
        return RefRegistry(tmp, "default", 3600000)

    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            reg = self._registry(tmp)
            sid = new_snapshot_id()
            reg.put_snapshot({
                "id": sid, "level": "uia",
                "window": {"hwnd": 1, "pid": 2, "title": "t", "rect": [0, 0, 10, 10]},
                "refs": {"e1": {"kind": "uia", "role": "Button", "name": "确定", "fingerprint": "Button|确定||",
                                "runtimeId": [1, 2], "rect": [1, 1, 5, 5], "hwnd": 1, "pid": 2}},
            })
            self.assertIsNotNone(reg.lookup(f"@{sid}:e1"))
            self.assertIsNone(reg.lookup(f"@{sid}:e2"))
            # 新实例（跨进程）可读
            reg2 = self._registry(tmp)
            self.assertIsNotNone(reg2.lookup(f"@{sid}:e1"))
            info = reg2.lookup(f"@{sid}:e1")
            self.assertEqual(info["fingerprint"], "Button|确定||")

    def test_parse_ref(self):
        self.assertEqual(parse_ref("@abcd1234:e12"), ("abcd1234", "e", 12))
        self.assertEqual(parse_ref("@x:b1"), ("x", "b", 1))
        for bad in ("abc:e1", "@:e1", "@a:x1", "@a:e", ""):
            with self.assertRaises(JevError):
                parse_ref(bad)

    def test_ttl_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            reg = RefRegistry(tmp, "default", 100)  # 100ms TTL
            sid = new_snapshot_id()
            reg.put_snapshot({"id": sid, "level": "uia", "window": {}, "refs": {"e1": {"kind": "uia"}}})
            self.assertIsNotNone(reg.lookup(f"@{sid}:e1"))
            time.sleep(0.15)
            reg2 = RefRegistry(tmp, "default", 100)
            self.assertIsNone(reg2.lookup(f"@{sid}:e1"))  # 过期被清理

    def test_legacy_list_refs_tolerated(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "default.json"
            sid = new_snapshot_id()
            now = int(time.time() * 1000)
            p.write_text(json.dumps({"schemaVersion": 1, "id": "default", "snapshots": {
                sid: {"createdAt": now, "level": "uia", "window": {},
                      "refs": [{"ref": f"@{sid}:e1", "kind": "uia"}]}}}), encoding="utf-8")
            reg = self._registry(tmp)
            self.assertIsNotNone(reg.lookup(f"@{sid}:e1"))


class TestEnvelope(unittest.TestCase):
    def test_metrics_tokens_unknown(self):
        m = Metrics()
        m.add_tokens(None)
        d = m.to_dict()
        self.assertTrue(d["tokens"]["inputUnknown"])
        m2 = Metrics()
        m2.add_tokens({"input_tokens": 5})
        self.assertEqual(m2.to_dict()["tokens"]["input"], 5)
        self.assertEqual(m2.to_dict()["tokens"]["outputUnknown"], True)

    def test_budget(self):
        cfg = load_config(env={})
        b = Budget(cfg, run_timeout_ms=300)
        b.check_deadline()
        time.sleep(0.35)
        with self.assertRaises(JevError) as cm:
            b.check_deadline()
        self.assertEqual(cm.exception.code, "BUDGET_EXCEEDED")

    def test_envelope_shape(self):
        e = envelope("done", result={"x": 1}, metrics={"elapsedMs": 1})
        self.assertEqual(e["schemaVersion"], 1)
        self.assertEqual(e["status"], "done")
        f = failed(err("TIMEOUT", "x", retryable=True))
        self.assertEqual(f["error"]["code"], "TIMEOUT")
        self.assertTrue(f["error"]["retryable"])


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class TestJudgeParsing(unittest.TestCase):
    def _client(self):
        cfg = load_config(env={"JEV_DESKTOP_JEV_PROVIDER": "custom",
                               "JEV_DESKTOP_JEV_BASE_URL": "http://127.0.0.1:9",
                               "JEV_DESKTOP_JEV_MODEL": "m"})
        import os
        os.environ["JEV_TEST_KEY"] = "k"
        cfg["jev"]["apiKeyEnv"] = "JEV_TEST_KEY"
        m = Metrics()
        return JevClient(cfg, m, env={"JEV_TEST_KEY": "k"})

    def test_choice_index_parsing(self):
        c = self._client()
        self.assertEqual(c.choice_index_from({"choice": {"choice": "c3"}}, "choice", 10), 3)
        self.assertEqual(c.choice_index_from({"choice": {"choice": "7"}}, "choice", 10), 7)
        self.assertIsNone(c.choice_index_from({"choice": {"choice": "none"}}, "choice", 10))
        self.assertIsNone(c.choice_index_from({"choice": {"choice": "c99"}}, "choice", 10))



class TestVlmParsing(unittest.TestCase):
    def test_parse_elements(self):
        from core.observe.vlm import parse_elements
        content = "```json\n" + json.dumps({
            "elements": [{"name": "开始", "type": "button",
                          "bbox": [10.2, 20, 80, 44.6], "action": "click"}]
        }, ensure_ascii=False) + "```"
        blocks = parse_elements(content)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0].text, "开始")
        self.assertEqual(blocks[0].rel_rect, (10, 20, 80, 45))
        with self.assertRaises(JevError):
            parse_elements("没有 json")
        with self.assertRaises(JevError):
            parse_elements('{"other": 1}')


if __name__ == "__main__":
    unittest.main(verbosity=2)
