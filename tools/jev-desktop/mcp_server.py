"""jev-desktop 的 MCP 适配器（stdio JSON-RPC 2.0，纯标准库手写）。

- stdout 是协议通道；一切日志写 stderr；
- TOOLS 元数据 → tools/list；tools/call → core.api.run_tool；
- desktop_screenshot 返回 MCP image 内容（供多模态宿主直接看图）；
- notifications/cancelled → 协作取消（尽力而为）；
- 请求在线程池执行，主循环保持读取（取消通知才能在长任务期间到达）。

为什么不走官方 mcp SDK：1.x→2.x 已发生 FastMCP→MCPServer 的破坏性改名，
本服务只需要 tools 子集的极小协议面，手写循环可零依赖稳定工作（server-py 同款做法）。
"""

import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from core import SERVER_NAME, SERVER_VERSION, TOOLS, tool_schema
from core import api as core_api

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

PROTOCOL_VERSION = "2025-06-18"
_write_lock = threading.Lock()


def _emit(obj: dict) -> None:
    with _write_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def _log(msg: str) -> None:
    print(f"[{SERVER_NAME}-mcp] {msg}", file=sys.stderr)


def _tool_to_mcp(tool: dict) -> dict:
    return {"name": tool["name"], "description": tool["description"], "inputSchema": tool_schema(tool)}


def _text_content(text: str) -> dict:
    return {"type": "text", "text": text}


def handle(method: str, params: dict, request_id=None) -> dict:
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "title": "jev-desktop 桌面控制", "version": SERVER_VERSION},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [_tool_to_mcp(t) for t in TOOLS]}
    if method == "tools/call":
        name = params.get("name", "")
        args = params.get("arguments") or {}
        if not any(t["name"] == name for t in TOOLS):
            return {"content": [_text_content(f"未知工具: {name}")], "isError": True}
        return_image = name == "desktop_screenshot"
        env_out = core_api.run_tool(name, args, session_id=args.get("session"),
                                    dry_run=bool(args.get("dry_run")), return_image=return_image,
                                    cancel=core_api.register_cancel(f"mcp:{request_id}"))
        return _envelope_to_content(env_out, return_image=return_image)
    raise ValueError(f"未知方法: {method}")


def _envelope_to_content(env_out: dict, *, return_image: bool = False) -> dict:
    """envelope → MCP CallToolResult：done → 正常；failed/cancelled → isError + 结构化错误。"""
    status = env_out.get("status")
    body = json.dumps(env_out, ensure_ascii=False, indent=1)
    contents = []
    if return_image and status == "done":
        image_b64 = ((env_out.get("result") or {}).get("imageBase64"))
        if image_b64:
            contents.append({"type": "image", "data": image_b64, "mimeType": "image/png"})
            brief = {k: v for k, v in (env_out.get("result") or {}).items() if k != "imageBase64"}
            contents.append(_text_content(json.dumps({"status": status, "result": brief,
                                                      "metrics": env_out.get("metrics")},
                                                     ensure_ascii=False)))
            return {"content": contents}
    contents.append(_text_content(body))
    if status in ("failed", "cancelled"):
        err = env_out.get("error") or {}
        return {"content": contents, "isError": True,
                **({"structuredContent": {"status": status, "error": err}} if err else {})}
    return {"content": contents}


def main() -> None:
    _log(f"MCP 服务已启动（stdio，v{SERVER_VERSION}）；工具数: {len(TOOLS)}；日志走 stderr")
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="jev-desktop")
    futures = {}
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                _log(f"忽略非法 JSON 行: {e}")
                continue
            method = msg.get("method", "")
            request_id = msg.get("id")
            if request_id is None:
                # notification
                if method == "notifications/cancelled":
                    token = (msg.get("params") or {}).get("requestId")
                    if token is not None and core_api.cancel_token(f"mcp:{token}"):
                        _log(f"已请求取消 requestId={token}")
                elif method == "notifications/initialized":
                    pass
                continue
            fut = pool.submit(_safe_handle, method, msg.get("params") or {}, request_id)
            futures[fut] = request_id
            # 回收已完成任务，保持 future 表有限
            done = [f for f in futures if f.done()]
            for f in done:
                del futures[f]
    except KeyboardInterrupt:
        _log("stdin 关闭/中断，退出")
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _safe_handle(method: str, params: dict, request_id) -> None:
    try:
        result = handle(method, params, request_id)
        _emit({"jsonrpc": "2.0", "id": request_id, "result": result})
    except ValueError as e:
        _emit({"jsonrpc": "2.0", "id": request_id,
               "error": {"code": -32601, "message": str(e)}})
    except Exception as e:  # noqa: BLE001
        _log(f"处理 {method} 异常: {type(e).__name__}: {e}")
        _emit({"jsonrpc": "2.0", "id": request_id,
               "error": {"code": -32603, "message": f"内部错误: {e}"}})


if __name__ == "__main__":
    main()
