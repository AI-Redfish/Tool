"""jev-desktop core：Windows 桌面控制（观察/动作/Jev 判断/规划），CLI 与 MCP 共享。

分层：core（本包，纯逻辑）+ cli.py + mcp_server.py（薄适配器）。
对外只需要 run_tool() 与 TOOLS 元数据。
"""

from .tooldata import SERVER_NAME, SERVER_VERSION, TOOLS, get_tool, tool_schema

__all__ = ["SERVER_NAME", "SERVER_VERSION", "TOOLS", "get_tool", "tool_schema"]
