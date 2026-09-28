# server-py —— 多入口工具最小示例（纯 Python 标准库）

> 与 `server-a` 完全同构的 Python 版：`core.py + cli.py + mcp_server.py`，零第三方依赖；示例工具 `echo` / `now`。版本 `0.1.0`。

## 技术原理

### 分层与调用链（谁调用谁）

```text
                 ┌────────────────────────────────────┐
                 │ core.py                             │
                 │  · 纯业务函数 echo()/now()           │
                 │  · TOOLS 元数据（单一事实来源）        │
                 │  · run_tool(name, args) 分发+校验    │
                 └──────────┬─────────────┬───────────┘
              ┌─────────────┴────┐   ┌────┴──────────────────┐
        cli.py               mcp_server.py
   argparse 子命令从         标准库手写 JSON-RPC
   TOOLS 自动生成             stdio 逐行循环
   → run_tool → 纯函数        → run_tool → 同一纯函数
```

两条入口完全对称，业务实现只有一份；CLI 子命令/帮助文案与 MCP 工具注册都从 `core.TOOLS` 生成，两侧不漂移。

### 关键机制

1. **MCP 是手写的，不用官方 SDK**：官方 `mcp` SDK 1.x→2.x 发生过 FastMCP→MCPServer 破坏性改名；为零版本风险，本文件只用标准库实现 tools 协议子集（逐行读 stdin、逐行写 stdout）。协议行为见下表：

| 输入帧 | 行为 |
|---|---|
| `initialize` | 返回 `serverInfo{name:"server-py",version:"0.1.0"}` + `capabilities{tools:{}}`；protocolVersion 回显请求值（缺省 `2024-11-05`） |
| `tools/list` | 从 TOOLS 生成工具清单（含 JSON Schema inputSchema） |
| `tools/call` | 转发 `run_tool()`；成功 → `content:[{type:"text"}]`；执行失败 → `isError:true` + 错误文本（不断会话） |
| 通知帧（无 `id`，如 `notifications/initialized`） | 静默忽略，不应答 |
| 未知方法 | `error{code:-32601, message:"未知方法：<method>"}` |
| 非法 JSON 行 | stderr 记录后跳过，进程不退出 |

2. **stdio 纪律与编码**：stdout 是协议通道，日志一律 stderr；Windows 控制台/管道默认可能是 GBK，启动时把 stdout/stderr `reconfigure` 为 UTF-8（中文与协议都不乱码）。
3. **CLI 参数双轨**：argparse 按 TOOLS 自动生成子命令，每个参数同时挂"位置式"与 `--name` 命名式两个入口（命名式优先）；必填校验在 `cli.py` 汇总报错。
4. **launcher.json 发现机制**：非 TypeScript 工具没有 `mcp/dist/index.js`，仓库启动器改读子目录声明文件 `{"command":"python","args":["mcp_server.py"]}`，以子进程拉起（cwd=工具目录），任意语言通用。字段：`command`（必填）/`args`/`description`/`setup`（可选，`build` 子命令时执行；本工具零依赖故不需要）。
5. **Python ≥ 3.10 的原因**：`core.py` 使用 `dict | None` 联合类型注解（PEP 604），3.9 导入即 `TypeError`。

## 使用步骤

### 步骤 0：前置

| 项 | 要求 |
| --- | --- |
| Python | ≥ 3.10 |
| 依赖 | 无（纯标准库，无需 pip/uv 安装任何包） |

所有命令在 `tools/server-py/` 目录下执行。

### 步骤 1：CLI 使用

**全局命令**：

| 命令 | 作用 | 预期输出 |
|---|---|---|
| `--version` | 版本 | `server-py-cli v0.1.0` |
| `-h` / `--help` | argparse 用法 | 用法文本 |
| 无子命令 / `list` | 工具清单 | 见下 |

```powershell
python cli.py list
# [server-py] 可用工具：
#   - echo    原样返回输入的消息（server-py 示例工具，Python 实现）
#   - now     返回服务器当前时间（server-py 示例工具，Python 实现）
```

**工具命令与参数**：

| 命令 | 参数 | 类型 | 必填 | 预期输出 |
|---|---|---|---|---|
| `echo` | `message` | string | 是 | `[server-py] echo: <message>` |
| `now` | — | — | — | `[server-py] server time: <ISO 8601+00:00>` |

```powershell
python cli.py echo 你好             # → [server-py] echo: 你好（位置式；控制台已强制 UTF-8）
python cli.py echo --message hello  # → [server-py] echo: hello（命名式，优先于位置式）
python cli.py now                   # → [server-py] server time: 2026-09-28T02:07:55.549485+00:00
python cli.py echo                  # 缺必填 → stderr：
                                    #   [server-py-cli] 工具 "echo" 缺少必填参数：message（要回显的消息）
```

**退出码**：`0` 成功；`1` 缺必填参数 / 未知工具 / 执行异常。

**排错**：`No module named core` → 必须从 server-py 目录启动（启动器已保证 cwd）；`TypeError: unsupported operand type(s) for |` → Python < 3.10，升级解释器。

### 步骤 2：MCP 使用

① 启动/注册：

```powershell
python mcp_server.py
# stderr: [server-py] MCP 服务已启动（stdio 传输，Python 实现）；stdout 保持纯协议
```

```json
{
  "mcpServers": {
    "server-py": {
      "command": "python",
      "args": ["D:/develop/GitNote/Redfish-AI/Tool/tools/server-py/mcp_server.py"]
    }
  }
}
```

> `python` 需在客户端进程 PATH 中（或写 python.exe 绝对路径）；args 用绝对路径。

② 可用工具（`tools/list` 应返回 2 个）：

| 工具 | 参数 | 类型 | 必填 |
|---|---|---|---|
| `echo` | `message` | string | 是 |
| `now` | — | — | — |

③ 手动冒烟（PowerShell，不依赖客户端）：

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"}}}
'@ | python mcp_server.py
# 第 2 帧应含 echo/now；第 3 帧应答 "[server-py] echo: hi"
```

### 步骤 3：仓库启动器（统一 MCP 入口）

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list          # 应列出 server-py（读 launcher.json）
node bin/tool-launcher.js server-py     # 按 launcher.json 拉起（command: python mcp_server.py）
```

拉起后进程常驻即成功。`launcher.json` 的 `command/args` 可换成任意可执行程序（node/go/java…）——这是任意语言工具接入启动器的唯一要求。
