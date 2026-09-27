"""观察数据模型：三档（uia/ocr/vlm）产出统一为同一快照格式（文本 + ref 列表，ADR-01）。"""

from dataclasses import dataclass, field


@dataclass
class SnapElement:
    """UIA 快照中的一个元素。"""
    ref: str                    # @<sid>:eN
    role: str                   # Button / Edit / Pane ...
    name: str
    automation_id: str
    class_name: str
    value: str
    rect: tuple[int, int, int, int]   # 物理像素 (l,t,r,b)
    offscreen: bool
    interactive: bool
    children_count: int
    depth: int
    runtime_id: list[int]
    hwnd: int
    pid: int
    fingerprint: str            # ControlType|Name|AutomationId|ClassName
    toggle_state: int | None = None   # 0=未选 1=已选 2=半选（CheckBox/RadioButton）

    def to_dict(self) -> dict:
        out = {
            "ref": self.ref, "role": self.role, "name": self.name,
            "automationId": self.automation_id, "rect": list(self.rect),
            "value": self.value[:80], "interactive": self.interactive,
            "children": self.children_count, "offscreen": self.offscreen,
        }
        if self.toggle_state is not None:
            out["toggleState"] = self.toggle_state
        return out


@dataclass
class TextBlock:
    """OCR / VLM 快照中的一个文字块（坐标为窗口相对物理像素）。"""
    ref: str                      # @<sid>:bN
    text: str
    rel_rect: tuple[int, int, int, int]
    confidence: float
    source: str = "ocr"           # ocr | vlm

    @property
    def rel_center(self) -> tuple[int, int]:
        l, t, r, b = self.rel_rect
        return ((l + r) // 2, (t + b) // 2)

    def to_dict(self) -> dict:
        l, t, r, b = self.rel_rect
        return {"ref": self.ref, "text": self.text, "rect": list(self.rel_rect),
                "center": list(self.rel_center), "confidence": round(self.confidence, 3),
                "source": self.source}


@dataclass
class Snapshot:
    id: str
    level: str                    # uia | ocr | vlm
    window: dict                  # {hwnd, pid, title, rect, process}
    elements: list[SnapElement] = field(default_factory=list)
    blocks: list[TextBlock] = field(default_factory=list)
    text: str = ""                # 紧凑文本快照
    truncated: bool = False
    notes: list[str] = field(default_factory=list)
    image_path: str | None = None
    elapsed_ms: int = 0

    def refs_payload(self) -> dict:
        out: dict = {}
        for e in self.elements:
            entry = {
                "kind": "uia", "role": e.role, "name": e.name, "automationId": e.automation_id,
                "class": e.class_name, "rect": list(e.rect), "fingerprint": e.fingerprint,
                "runtimeId": e.runtime_id, "hwnd": e.hwnd, "pid": e.pid,
                "children": e.children_count,
            }
            if e.toggle_state is not None:
                entry["toggleState"] = e.toggle_state
            out[e.ref.split(":")[-1]] = entry
        win = self.window.get("rect") or (0, 0, 0, 0)
        for b in self.blocks:
            out[b.ref.split(":")[-1]] = {
                "kind": "block", "text": b.text[:120], "relRect": list(b.rel_rect),
                "confidence": round(b.confidence, 3), "source": b.source,
                "hwnd": self.window.get("hwnd"), "pid": self.window.get("pid"),
                "windowRect": list(win),
            }
        return out

    def to_registry_dict(self) -> dict:
        """会话文件存储格式（refs 为以 eN/bN 为键的映射）。"""
        return {
            "id": self.id,
            "level": self.level,
            "window": {
                "hwnd": self.window.get("hwnd"), "pid": self.window.get("pid"),
                "title": self.window.get("title"), "rect": list(self.window.get("rect") or []),
                "process": self.window.get("process"),
            },
            "refs": self.refs_payload(),
        }

    def to_dict(self, *, include_refs: bool = True) -> dict:
        out = {
            "id": self.id,
            "snapshotId": self.id,
            "level": self.level,
            "window": {
                "hwnd": self.window.get("hwnd"), "pid": self.window.get("pid"),
                "title": self.window.get("title"), "rect": list(self.window.get("rect") or []),
                "process": self.window.get("process"),
            },
            "text": self.text,
            "truncated": self.truncated,
            "notes": self.notes,
            "elapsedMs": self.elapsed_ms,
        }
        if self.image_path:
            out["image"] = self.image_path
        if include_refs:
            refs = self.refs_payload()
            out["refs"] = [{"ref": f"@{self.id}:{k}", **v} for k, v in refs.items()]
        return out


def estimate_tokens(text: str) -> int:
    """粗略 token 估计（中文≈1字/token，英文≈4字符/token，取保守上界）。"""
    if not text:
        return 0
    cjk = sum(1 for ch in text if ord(ch) > 0x2E00)
    other = len(text) - cjk
    return cjk + other // 4
