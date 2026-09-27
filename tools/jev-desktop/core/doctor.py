"""doctor 环境诊断（DESIGN §10.1/§15）：能力探测，绝不打印 secret。

默认不访问网络；with_network=True 才对 Jev/规划器各发一次极小连通请求。
"""

import os
import sys
import time

from . import winapi
from .config import credential_present, redact_config
from .errors import JevError
from .planner import planner_configured


def run_doctor(ctx, *, with_network: bool = False) -> dict:
    checks: list[dict] = []

    def add(name: str, ok: bool, detail: str, **extra):
        item = {"name": name, "ok": ok, "detail": detail}
        item.update(extra)
        checks.append(item)
        return item

    # 平台
    if sys.platform == "win32":
        add("platform", True, f"Windows（Python {sys.version.split()[0]}）")
    else:
        add("platform", False, f"非 Windows 平台（{sys.platform}）：UIA/SendInput/截图均不可用；"
                               "工具进程必须运行在 Windows 侧，不能在 WSL 内")

    # DPI
    dpi = winapi.ensure_dpi_awareness()
    add("dpi", dpi != "未设置", f"DPI 感知: {dpi}（影响截图/UIA 矩形/点击坐标一致性）")

    # 屏幕
    try:
        vs = winapi.virtual_screen()
        add("screen", vs[2] > 0, f"虚拟屏 {vs[2]}x{vs[3]} @ ({vs[0]},{vs[1]})")
    except Exception as e:
        add("screen", False, f"屏幕信息获取失败: {e}")

    # 窗口枚举
    try:
        wins = winapi.list_top_windows()
        add("windows", len(wins) > 0, f"可见顶层窗口 {len(wins)} 个")
    except Exception as e:
        add("windows", False, f"窗口枚举失败: {e}")

    # UIA
    uia_ok, uia_detail = _check_uia(ctx)
    add("uia", uia_ok, uia_detail,
        supported=uia_ok, hint=None if uia_ok else "pip install -r requirements.txt")

    # 截图
    shot_ok, shot_detail = _check_screenshot(ctx)
    add("screenshot", shot_ok, shot_detail,
        supported=shot_ok, hint=None if shot_ok else "pip install -r requirements.txt（mss）")

    # OCR
    try:
        from .observe import ocr as ocr_mod
        avail = ocr_mod.backend_available()
        add("ocr", avail, "rapidocr 可用（首次使用会懒加载模型）" if avail
            else "rapidocr 未安装：ocr 档不可用（可改用 vlm 档）",
            supported=avail, hint=None if avail else "pip install -r requirements-ocr.txt")
    except Exception as e:
        add("ocr", False, f"OCR 检查失败: {e}", supported=False)

    # 剪贴板
    try:
        winapi.clipboard_get()
        add("clipboard", True, "剪贴板可读")
    except Exception as e:
        add("clipboard", False, f"剪贴板不可用: {e}")

    # 提权状态（UIPI）
    elevated = winapi.is_user_admin()
    add("elevation", True,
        f"当前进程{'以管理员运行（可操作提权窗口）' if elevated else '非管理员：无法对管理员窗口合成输入/部分 UIA 操作（UIPI）'}",
        elevated=elevated)

    # 会话目录
    try:
        os.makedirs(ctx.cfg["session"]["dir"], exist_ok=True)
        probe = os.path.join(ctx.cfg["session"]["dir"], ".probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
        add("session_dir", True, ctx.cfg["session"]["dir"])
    except OSError as e:
        add("session_dir", False, f"会话目录不可写: {e}")

    # 配置与凭据（脱敏）
    jev_present = credential_present(ctx.cfg, "jev", env=ctx.env)
    add("jev_key", jev_present,
        f"Jev key 环境变量 {ctx.cfg['jev']['apiKeyEnv']} {'已设置' if jev_present else '未设置（语义目标/goal/run 不可用，确定性动作不受影响）'}")
    planner_ready = planner_configured(ctx.cfg, env=ctx.env)
    add("planner", planner_ready,
        f"规划器 {'已配置（run 可用）' if planner_ready else '未配置（run 返回 PLANNER_NOT_CONFIGURED）'}")

    # 联网连通
    if with_network:
        add("jev_network", *_check_jev_network(ctx))
        add("planner_network", *_check_planner_network(ctx))

    ok_count = sum(1 for c in checks if c["ok"])
    return {
        "checks": checks,
        "summary": {"ok": ok_count, "total": len(checks), "elevated": elevated, "dpi": dpi},
        "config": redact_config(ctx.cfg),
        "note": "输出已脱敏：只显示 key 的环境变量名，绝不显示值",
    }


def _check_uia(ctx) -> tuple[bool, str]:
    try:
        uia = ctx.worker.import_uia()

        def _walk():
            root = uia.GetRootControl()
            children = root.GetChildren()
            return len(children)

        t0 = time.monotonic()
        n = ctx.worker.call(_walk, 8.0, "UIA 根元素探测")
        ms = int((time.monotonic() - t0) * 1000)
        return True, f"uiautomation 可用：桌面根元素 {n} 个子窗口（探测 {ms}ms）"
    except JevError as e:
        return False, e.message
    except Exception as e:
        return False, f"UIA 探测失败: {e}"


def _check_screenshot(ctx) -> tuple[bool, str]:
    try:
        from .observe import screenshot as shot

        def _do():
            screen = shot.grab_rect(ctx.worker, (0, 0, 64, 64))
            return screen.size

        size = ctx.worker.call(_do, 8.0, "截图探测")
        return True, f"mss 截图可用（{size[0]}x{size[1]} 探测帧）"
    except JevError as e:
        return False, e.message
    except Exception as e:
        return False, f"截图探测失败: {e}"


def _check_jev_network(ctx) -> tuple[bool, str]:
    try:
        jev = ctx.jev_required()
        t0 = time.monotonic()
        verdicts = jev.noul_batch(state={"ping": "doctor 连通性测试"},
                                  questions={"q": "这是一次连通性测试，请返回 1。"}, timeout_s=20.0)
        ms = int((time.monotonic() - t0) * 1000)
        _ = verdicts
        return True, f"Jev 端点连通（{ctx.cfg['jev']['provider']} {ctx.cfg['jev']['baseUrl']}，{ms}ms）"
    except JevError as e:
        return False, f"Jev 连通失败: {e.message}"


def _check_planner_network(ctx) -> tuple[bool, str]:
    if not planner_configured(ctx.cfg, env=ctx.env):
        return False, "规划器未配置，跳过连通测试"
    try:
        from .planner import Planner
        planner = Planner(ctx.cfg, ctx.metrics, env=ctx.env)
        t0 = time.monotonic()
        content = planner._chat([{"role": "user", "content": "回复 ok 两个字母即可"}],
                                json_mode=False, timeout_s=30.0)
        ms = int((time.monotonic() - t0) * 1000)
        return True, f"规划端点连通（{ctx.cfg['planner']['model']}，{ms}ms，响应 {len(content)} 字符）"
    except JevError as e:
        return False, f"规划器连通失败: {e.message}"
    except Exception as e:
        return False, f"规划器连通失败: {e}"
