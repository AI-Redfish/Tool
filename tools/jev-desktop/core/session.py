"""ref 注册表与会话（DESIGN ADR-03 / §4.2）。

ref 形如 `@<snapshotId>:eN`（UIA 元素）/ `@<snapshotId>:bN`（OCR/VLM 文字块）。
- 内存 + 会话文件双写：MCP 长进程与 CLI 跨命令共用同一格式；
- 会话文件：%LOCALAPPDATA%\\AI-Redfish\\jev-desktop\\sessions\\<id>.json，快照级 TTL；
- 动作前活性校验在 targeting.resolve_ref 实现（pid/指纹/矩形），本模块只管存取与过期。
"""

import json
import re
import time
import uuid
from pathlib import Path

from . import winapi
from .errors import err

REF_PATTERN = re.compile(r"^@([A-Za-z0-9]+):(e|b)(\d+)$")
REF_DRIFT_PX = 60  # 兜底搜索时允许的矩形漂移（物理像素）


def new_snapshot_id() -> str:
    return uuid.uuid4().hex[:8]


def parse_ref(ref: str) -> tuple[str, str, int]:
    m = REF_PATTERN.match(ref.strip())
    if not m:
        raise err("INVALID_PARAMS",
                  f"ref 格式非法: {ref!r}，应为 @<快照id>:eN 或 @<快照id>:bN（由 desktop_snapshot 返回）")
    return m.group(1), m.group(2), int(m.group(3))


class RefRegistry:
    def __init__(self, session_dir: str, session_id: str, ttl_ms: int):
        self.dir = Path(session_dir)
        self.session_id = session_id or "default"
        self.ttl_ms = ttl_ms
        self.data: dict = {"schemaVersion": 1, "id": self.session_id, "updatedAt": 0, "snapshots": {}}
        self._last_window_hint: dict | None = None
        self._load()

    # -- 持久化 --------------------------------------------------------------

    @property
    def path(self) -> Path:
        return self.dir / f"{self.session_id}.json"

    def _load(self) -> None:
        p = self.path
        if not p.exists():
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(data, dict) or not isinstance(data.get("snapshots"), dict):
            return
        self.data = data
        self.data["id"] = self.session_id
        lw = data.get("lastWindow")
        self._last_window_hint = lw if isinstance(lw, dict) else None
        # 规范化 refs：容忍旧格式（列表）与损坏条目
        for sid, snap in self.data["snapshots"].items():
            if not isinstance(snap, dict):
                self.data["snapshots"][sid] = {"createdAt": 0, "refs": {}}
                continue
            refs = snap.get("refs")
            if isinstance(refs, list):
                fixed: dict = {}
                for item in refs:
                    if isinstance(item, dict) and isinstance(item.get("ref"), str):
                        fixed[item["ref"].split(":")[-1]] = item
                snap["refs"] = fixed
            elif not isinstance(refs, dict):
                snap["refs"] = {}
        self._prune()

    def _prune(self) -> None:
        now = int(time.time() * 1000)
        expired = [sid for sid, s in self.data["snapshots"].items()
                   if not isinstance(s, dict) or now - s.get("createdAt", 0) > self.ttl_ms]
        for sid in expired:
            del self.data["snapshots"][sid]

    def save(self) -> None:
        self.data["updatedAt"] = int(time.time() * 1000)
        self._prune()
        if self._last_window_hint:
            self.data["lastWindow"] = self._last_window_hint
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            pass  # 会话持久化失败不阻塞动作（内存注册表仍可用）

    # -- 快照与 ref ----------------------------------------------------------

    def put_snapshot(self, snapshot: dict) -> None:
        """snapshot: observe 返回的 to_dict()（含 id/level/window/refs）。"""
        sid = snapshot["id"]
        self.data["snapshots"][sid] = {
            "createdAt": int(time.time() * 1000),
            "level": snapshot.get("level"),
            "window": snapshot.get("window", {}),
            "refs": snapshot.get("refs", {}),
        }
        # 会话内快照数上限：只保留最近 8 个，防止文件膨胀
        items = sorted(self.data["snapshots"].items(), key=lambda kv: kv[1].get("createdAt", 0))
        for sid_old, _ in items[:-8]:
            del self.data["snapshots"][sid_old]
        self.save()

    def lookup(self, ref: str) -> dict | None:
        sid, kind, idx = parse_ref(ref)
        snap = self.data["snapshots"].get(sid)
        if not snap:
            return None
        refs = snap.get("refs")
        if not isinstance(refs, dict):
            return None
        return refs.get(f"{kind}{idx}")

    def snapshot_meta(self, sid: str) -> dict | None:
        return self.data["snapshots"].get(sid)

    def last_window(self) -> dict | None:
        """最近一次快照/动作的窗口信息（供缺省目标选择）。"""
        snaps = [s for s in self.data["snapshots"].values() if isinstance(s.get("window"), dict)]
        if not snaps:
            return self._last_window_hint
        snaps.sort(key=lambda s: s.get("createdAt", 0))
        return snaps[-1]["window"]

    def set_last_window_hwnd(self, hwnd: int) -> None:
        """launch 后记录新窗口（会话内缺省目标）。"""
        self._last_window_hint = {"hwnd": hwnd, "pid": winapi.window_pid(hwnd),
                                  "title": winapi.window_title(hwnd),
                                  "rect": list(winapi.window_rect(hwnd) or ())}
        self.save()

    def check_ttl(self, ref: str) -> None:
        sid, _, _ = parse_ref(ref)
        snap = self.data["snapshots"].get(sid)
        if not snap:
            return
        age = int(time.time() * 1000) - snap.get("createdAt", 0)
        if age > self.ttl_ms:
            raise err("STALE_REF", f"ref {ref} 所在快照已过期（TTL {self.ttl_ms}ms，已 {age}ms）；请重新 desktop_snapshot",
                      details={"ref": ref, "ageMs": age, "ttlMs": self.ttl_ms})


def fingerprint_rect_drift(old: tuple, new: tuple) -> int:
    """矩形中心漂移（物理像素）。"""
    if not old or not new:
        return 10**9
    ocx, ocy = (old[0] + old[2]) / 2, (old[1] + old[3]) / 2
    ncx, ncy = (new[0] + new[2]) / 2, (new[1] + new[3]) / 2
    return int(((ocx - ncx) ** 2 + (ocy - ncy) ** 2) ** 0.5)
