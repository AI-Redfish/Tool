"""mss 截图适配（DESIGN §4.1）：区域优先，artifact 落盘，VLM 降采样。

全部 mss 调用经 UiaWorker 串行执行（mss 实例按线程缓存）。
"""

import io
import time
from pathlib import Path

from ..errors import err


def grab_rect(worker, rect: tuple[int, int, int, int] | None):
    """截取物理像素区域 rect=(l,t,r,b)；None=主显示器整屏。返回 mss screen 对象。"""
    def _do():
        sct = worker.mss_instance()
        if rect is None:
            region = sct.monitors[1]
        else:
            l, t, r, b = rect
            region = {"left": int(l), "top": int(t), "width": max(1, int(r - l)), "height": max(1, int(b - t))}
        return sct.grab(region)

    return worker.call(_do, 10.0, "mss 截图")


def to_png_bytes(screen) -> bytes:
    mss = None
    try:
        import mss as mss_mod
        mss = mss_mod
    except Exception:
        pass
    if mss is None:
        raise err("UIA_UNAVAILABLE", "mss 未安装：uv sync（在 tools/jev-desktop/ 下）")
    from PIL import Image
    img = Image.frombytes("RGB", screen.size, screen.rgb)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def to_pil(screen):
    from PIL import Image
    return Image.frombytes("RGB", screen.size, screen.rgb)


def save_artifact(artifacts_dir: str, screen, prefix: str = "shot") -> str:
    """截图落盘为 PNG artifact，返回路径。"""
    try:
        out_dir = Path(artifacts_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"{prefix}-{time.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 10000}.png"
        path.write_bytes(to_png_bytes(screen))
        return str(path)
    except OSError as e:
        raise err("INTERNAL_ERROR", f"artifact 保存失败: {e}")


def downscale_jpeg(screen, *, max_side: int = 1568, quality: int = 80) -> tuple[bytes, int, int]:
    """VLM 档（DESIGN ADR-01）：≤1568px、JPEG q80。返回 (bytes, 缩放后宽, 缩放后高)。"""
    img = to_pil(screen)
    w, h = img.size
    scale = 1.0
    if max(w, h) > max_side:
        scale = max_side / max(w, h)
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue(), img.size[0], img.size[1]


def capture_to_file(worker, artifacts_dir: str, rect: tuple | None, prefix: str = "shot") -> tuple[str, tuple[int, int]]:
    """截取并保存，返回 (路径, 原始尺寸)。"""
    screen = grab_rect(worker, rect)

    def _do():
        return save_artifact(artifacts_dir, screen, prefix)

    path = worker.call(_do, 10.0, "保存截图 artifact")
    return path, screen.size
