"""专用 UIA 工作线程 + 任务队列（DESIGN ADR-06 / §4.2）。

所有 COM/UIA/mss 调用串行化在单一 STA 线程执行：
- 规避 COM 跨线程初始化与自竞争；
- MCP/CLI 的并发请求在此自然排队；
- 单任务超时保护：超时抛 TIMEOUT 并"毒化"当前线程（放弃悬死的 COM 调用，重建线程），
  保证工具进程不会因目标窗口挂起而永久卡死（DEVELOPMENT_PLAN P0 卡死防护）。

依赖注入接缝：core 不直接 import uiautomation/comtypes/mss，统一经本线程惰性加载；
未安装时抛 UIA_UNAVAILABLE / OCR_UNAVAILABLE，确定性路径（纯 ctypes）完全不受影响。
"""

import queue
import threading
import time
import traceback

from .errors import err
from . import winapi

_COINIT_APARTMENTTHREADED = 0x2


class _Job:
    __slots__ = ("fn", "desc", "event", "result", "error")

    def __init__(self, fn, desc):
        self.fn = fn
        self.desc = desc
        self.event = threading.Event()
        self.result = None
        self.error: BaseException | None = None


class UiaWorker:
    """call(fn, timeout_s, desc)：在 UIA 专用 STA 线程执行 fn 并等待结果。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: "queue.Queue[_Job]" = queue.Queue()
        self._thread: threading.Thread | None = None
        self._gen = 0
        self._local = threading.local()
        self._modules: dict[str, object] = {}

    # -- 线程管理 -----------------------------------------------------------

    def _ensure_thread(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._gen += 1
        gen = self._gen
        t = threading.Thread(target=self._loop, args=(gen,), name=f"jev-desktop-uia-{gen}", daemon=True)
        self._thread = t
        t.start()

    def _loop(self, my_gen: int) -> None:  # pragma: no cover - 线程体
        try:
            winapi.ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED)
        except Exception:
            pass
        try:
            while my_gen == self._gen:
                # 带超时取任务：空闲时泵消息；被毒化（gen 变更）时自行退出
                try:
                    job = self._jobs.get(timeout=0.2)
                except queue.Empty:
                    self._pump()
                    continue
                if job is None:
                    continue  # 兼容旧哨兵，直接忽略
                try:
                    job.result = job.fn()
                except BaseException as e:  # noqa: BLE001 - 必须回传到调用方
                    job.error = e
                finally:
                    job.event.set()
                    self._pump()
        finally:
            try:
                winapi.ole32.CoUninitialize()
            except Exception:
                pass

    def _pump(self) -> None:
        """STA 线程消息泵：让跨套间封送与剪贴板等系统消息得到处理。"""
        try:
            msg = winapi.wt.MSG()
            PM_REMOVE = 1
            while winapi.user32.PeekMessageW(winapi.ctypes.byref(msg), 0, 0, 0, PM_REMOVE):
                winapi.user32.TranslateMessage(winapi.ctypes.byref(msg))
                winapi.user32.DispatchMessageW(winapi.ctypes.byref(msg))
        except Exception:
            pass

    def _poison(self) -> None:
        """超时后放弃当前线程（悬死 COM 调用随其自然结束），递增代数并重建线程。

        旧线程在当前任务返回后通过代数检查自行退出；不能向队列投哨兵，
        否则哨兵会被新一代线程消费导致其退出（毒化恢复失效）。
        """
        old = self._thread
        with self._lock:
            if old is not None and old is threading.current_thread():
                return
            self._thread = None
            self._gen += 1

    # -- 对外接口 -----------------------------------------------------------

    def call(self, fn, timeout_s: float, desc: str):
        self._ensure_thread()
        if threading.current_thread() is self._thread:
            return fn()  # worker 内部再入
        job = _Job(fn, desc)
        self._jobs.put(job)
        if not job.event.wait(timeout_s):
            self._poison()
            raise err("TIMEOUT", f"{desc} 超时（{timeout_s:.1f}s）：目标窗口可能无响应或桌面被锁定；"
                                 "可重试或改用更低观察档位", details={"op": desc, "timeoutMs": int(timeout_s * 1000)})
        if job.error is not None:
            raise job.error
        return job.result

    # -- 惰性模块加载 -------------------------------------------------------

    def import_uia(self):
        """在工作线程内导入 uiautomation（comtypes 需要 STA）。未安装抛 UIA_UNAVAILABLE。"""
        if "uia" in self._modules:
            return self._modules["uia"]

        def _do():
            try:
                import uiautomation  # noqa: PLC0415
            except Exception as e:  # ImportError 或 comtypes 初始化失败
                raise err("UIA_UNAVAILABLE",
                          f"uiautomation 导入失败：{e}。请先安装依赖：pip install -r requirements.txt（含 uiautomation==2.0.29）")
            return uiautomation

        mod = self.call(_do, 30.0, "导入 uiautomation")
        self._modules["uia"] = mod
        return mod

    def import_mss(self):
        if "mss" in self._modules:
            return self._modules["mss"]

        def _do():
            try:
                import mss  # noqa: PLC0415
            except Exception as e:
                raise err("UIA_UNAVAILABLE", f"mss 导入失败：{e}。请先安装依赖：pip install -r requirements.txt")
            return mss

        mod = self.call(_do, 30.0, "导入 mss")
        self._modules["mss"] = mod
        return mod

    def mss_instance(self):
        """mss 实例按线程缓存（mss 非线程安全）。"""
        inst = getattr(self._local, "mss", None)
        if inst is None:
            mss = self.import_mss()
            factory = getattr(mss, "MSS", None) or mss.mss  # 10.x 推荐 mss.MSS
            inst = factory()
            self._local.mss = inst
        return inst

    def module_ok(self, name: str) -> bool:
        """仅探测可导入性（不初始化 OCR 模型），供 doctor 使用。"""
        try:
            __import__(name)
            return True
        except Exception:
            return False


def format_internal_error(e: BaseException) -> str:
    return "".join(traceback.format_exception_only(type(e), e)).strip()[:500]


def sleep_s(seconds: float) -> None:
    time.sleep(max(0.0, seconds))
