# server-py —— 多入口工具最小示例（纯 Python 标准库）

> 与 `server-a` 完全同构的 Python 版：`core.py + cli.py + mcp_server.py` 三层，零第三方依赖。
> 自带两个示例工具：`echo`（回显消息）、`now`（服务器 UTC 时间）。
> 额外演示：**任意语言工具**只要放一个 `launcher.json` 声明启动命令，就能被仓库启动器拉起。

## 底层实现原理

### 1. 分层：与 server-a 一一对应

```text
                 ┌────────────────────────────────┐
                 │ core.py                         │
                 │  · 纯业务函数 echo()/now()       │
                 │  · TOOLS 元数据（单一事实来源）    │
                 │  · run_tool() 统一分发+校验       │
                 └──────────┬─────────────────────┘
              ┌─────────────┴─────────────┐
        cli.py                       mcp_server.py
   （argparse 子命令从              （标准库手写 JSON-RPC
     TOOLS 自动生成）                  stdio 循环）
```

- **core.py 不感知任何对外方式**：只有纯函数 + 工具元数据 + `run_tool(name, args)`（做最小类型校验后分发，保证两个入口行为一致）。
- **TOOLS 元数据单一事实来源**：CLI 子命令/帮助文案与 MCP 工具注册都从这里生成，两侧不漂移。

### 2. CLI 适配器（`cli.py`）

argparse 按元数据自动生成子命令；每个参数**同时支持位置式与 `--name` 命名式**（命名式优先）。Windows 控制台默认 GBK，启动时把 stdout/stderr `reconfigure` 为 UTF-8 避免中文乱码。

### 3. MCP 适配器（`mcp_server.py`）：手写 JSON-RPC stdio 循环

**不依赖官方 `mcp` SDK**（1.x→2.x 已发生 FastMCP→MCPServer 破坏性改名，为零版本风险改用标准库手写），只实现工具协议子集：

- `initialize` → 返回 `serverInfo`（名称/版本）与能力声明
- `tools/list` → 从 `TOOLS` 元数据生成 inputSchema
- `tools/call` → 转发 `core.run_tool()`，结果包装为 MCP `content: [{type:"text"}]`
- 通知帧（无 `id`，如 `notifications/initialized`）不应答；按行读写 JSON，stdout 是纯协议通道

### 4. 启动器如何发现它：`launcher.json`

非 TypeScript 工具没有 `mcp/dist/index.js`，启动器改为读子目录的声明文件：

```json
{ "command": "python", "args": ["mcp_server.py"] }
```

启动器据此以子进程方式拉起，任意语言通用。

## 接入方式与使用步骤

### 方式一：CLI

无需任何安装（纯标准库，Python 3.9+）。每条命令的预期输出：

```powershell
cd tools/server-py
python cli.py list                  # [server-py] 可用工具：
                                    #   - echo    原样返回输入的消息（…）
                                    #   - now     返回服务器当前时间（…）
python cli.py echo hello            # → [server-py] echo: hello（位置参数）
python cli.py echo --message hello  # → 同上（命名式优先）
python cli.py now                   # → [server-py] server time: 2026-…T…Z+00:00
python cli.py echo                  # 缺必填参数 → stderr 报错，退出码 1
```

`list` 与帮助由 core 的 `TOOLS` 元数据自动生成；Windows 控制台已自动切 UTF-8，中文不乱码。

### 方式二：stdio MCP Server

在 MCP 客户端注册：

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

注册后可用工具：`echo`（参数 `message: string`）、`now`。验证：客户端连接后 `tools/list` 应返回 2 个工具；服务支持的协议方法：`initialize` / `tools/list` / `tools/call`（通知帧不应答）。stdio 模式下 stdout 是纯协议通道，任何打印调试信息到 stdout 的改动都会破坏协议（日志写 stderr）。

异常排查：客户端连不上 → 先跑 `python mcp_server.py` 看是否常驻不报错；报 `No module named core` → 必须从 server-py 目录启动（或客户端 cwd 指向该目录）。

### 方式三：仓库统一启动器

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list          # 确认识别 server-py（读 launcher.json 声明）
node bin/tool-launcher.js server-py     # 按 launcher.json 拉起（command: python mcp_server.py）
```

验证：拉起后进程常驻即成功；launcher.json 的 `command/args` 可换成任意可执行程序（node/go/java…），这是任意语言工具接入的唯一要求。

## 如何扩展一个新工具

1. `core.py`：写纯函数 + `TOOLS` 加元数据 + `run_tool` 加分发分支（含类型校验）；
2. CLI 与 MCP 无需改动（都从元数据生成）；
3. 两个入口同时生效。

## 文档导航

- 上层约定：[../README.md](../README.md)（launcher.json 协议、多语言工具模式）
- 同构 TypeScript 实现：[../server-a/README.md](../server-a/README.md)
