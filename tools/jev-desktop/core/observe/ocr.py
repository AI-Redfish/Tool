"""rapidocr 适配（DESIGN ADR-01）：截图 → 文字块（文本+中心坐标+置信度）。

模型懒加载（首次 OCR 才初始化）；兼容 rapidocr v3 统一包与旧 rapidocr_onnxruntime 包。
坐标输出为窗口相对物理像素（窗口移动不失效，ref 校验见 targeting）。
"""

import threading

from ..errors import err
from .model import TextBlock

_ENGINE_LOCK = threading.Lock()
_ENGINE: dict = {"key": None, "engine": None}


def backend_available() -> bool:
    try:
        import rapidocr  # noqa: F401
        return True
    except Exception:
        try:
            import rapidocr_onnxruntime  # noqa: F401
            return True
        except Exception:
            return False


def engine_loaded() -> bool:
    return _ENGINE["engine"] is not None


def _get_engine():
    """懒加载 OCR 引擎（进程内单例）。"""
    with _ENGINE_LOCK:
        if _ENGINE["engine"] is not None:
            return _ENGINE["engine"]
        try:
            import logging
            import rapidocr  # type: ignore
            # rapidocr 的 INFO 日志走自己的 logger，压到 WARNING 以下（stderr 纪律）
            for lname in list(logging.root.manager.loggerDict) + ["RapidOCR"]:
                if "rapid" in lname.lower():
                    logging.getLogger(lname).setLevel(logging.WARNING)
            engine = rapidocr.RapidOCR()
            _ENGINE["key"] = "rapidocr"
            _ENGINE["engine"] = engine
            return engine
        except Exception:
            pass
        try:
            import rapidocr_onnxruntime  # type: ignore
            engine = rapidocr_onnxruntime.RapidOCR()
            _ENGINE["key"] = "rapidocr_onnxruntime"
            _ENGINE["engine"] = engine
            return engine
        except Exception as e:
            raise err("OCR_UNAVAILABLE",
                      f"rapidocr 不可用：{e}。请安装 OCR 依赖：uv sync --extra ocr（在 tools/jev-desktop/ 下）"
                      "（或改用 vlm 档）")


def _detect(image_bytes: bytes) -> list[tuple[list[list[float]], str, float]]:
    """调用 OCR，统一返回 [(四点多边形, 文本, 置信度), ...]。"""
    engine = _get_engine()
    from PIL import Image
    import io
    img = Image.open(io.BytesIO(image_bytes))
    import numpy as np
    arr = np.asarray(img)
    result = engine(arr)
    out: list[tuple[list[list[float]], str, float]] = []
    if result is None:
        return out
    # v3：RapidOCROutput(boxes/txts/scores)
    if hasattr(result, "txts"):
        boxes = getattr(result, "boxes", None)
        txts = getattr(result, "txts", None) or ()
        scores = getattr(result, "scores", None) or ()
        if boxes is None:
            return out
        for i, txt in enumerate(txts):
            score = float(scores[i]) if i < len(scores) else 0.0
            out.append(([[float(p[0]), float(p[1])] for p in boxes[i]], str(txt), score))
        return out
    # 旧版：[res, elapse]，res=[[box, text, score], ...]
    res = result[0] if isinstance(result, (list, tuple)) and len(result) == 2 else result
    for item in res or []:
        try:
            box, txt, score = item
            out.append(([[float(p[0]), float(p[1])] for p in box], str(txt), float(score)))
        except Exception:
            continue
    return out


def recognize(image_bytes: bytes, *, min_score: float = 0.5) -> list[TextBlock]:
    """识别并以版面顺序（上→下、行内左→右）返回文字块（窗口相对坐标由调用方平移）。"""
    items = _detect(image_bytes)
    blocks: list[TextBlock] = []
    for poly, text, score in items:
        if not text.strip() or score < min_score:
            continue
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        rel_rect = (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))
        blocks.append(TextBlock(ref="", text=text.strip(), rel_rect=rel_rect, confidence=score))
    _sort_layout(blocks)
    return blocks


def _sort_layout(blocks: list[TextBlock]) -> None:
    """行分组：垂直中心接近的归同一行；行内按 x 排序，行间按 y 排序。"""
    if not blocks:
        return
    def key(b: TextBlock):
        return (b.rel_rect[1], b.rel_rect[0])
    blocks.sort(key=key)
    rows: list[list[TextBlock]] = []
    for b in blocks:
        placed = False
        for row in rows:
            ref_top = row[0].rel_rect[1]
            ref_h = row[0].rel_rect[3] - row[0].rel_rect[1]
            if abs(b.rel_rect[1] - ref_top) <= max(8, ref_h * 0.6):
                row.append(b)
                placed = True
                break
        if not placed:
            rows.append([b])
    rows.sort(key=lambda r: min(b.rel_rect[1] for b in r))
    out: list[TextBlock] = []
    for row in rows:
        row.sort(key=lambda b: b.rel_rect[0])
        out.extend(row)
    blocks[:] = out


def assign_refs(blocks: list[TextBlock], snapshot_id: str) -> None:
    for i, b in enumerate(blocks, start=1):
        b.ref = f"@{snapshot_id}:b{i}"


def render_lines(snapshot_id: str, blocks: list[TextBlock]) -> list[str]:
    lines = []
    for b in blocks:
        l, t, r, bo = b.rel_rect
        lines.append(f"[{b.ref}] \"{b.text}\" c={b.confidence:.2f} ({l},{t},{r},{bo})")
    return lines
