# server-a —— 多入口工具最小示例（TypeScript）

> `core + cli + mcp` 三包工作区；示例工具：`echo`（回显）、`now`（UTC 时间）。版本 `0.1.0`。

## 技术原理

### 分层与调用链（谁调用谁）

```text
                 ┌──────────────────────────────────────┐
                 │ core（@ai-redfish/server-a-core）                │
                 │  · 纯业务函数 echo()/now()                      │
                 │  · TOOLS 元数据（名称/描述/参数列表）              │
                 │  · runTool(name, args) 统一分发 + 参数校验        │
                 └──────────┬───────────────────┬──────┘
              ┌─────────────┴─────┐      ┌──────┴──────────────┐
   cli/src/index.ts          mcp/src/index.ts
   argv 解析 → buildToolArgs     MCP SDK 收 tools/call
   → runTool → 纯函数            → handler → 同一纯函数
```

两条入口的调用链完全对称，业务实现只有一份：

| 入口 | 调用链 |
|---|---|
| CLI | `argv` → `parseCliArgs`（`--name value` / `--name=value` / 位置参数）→ `buildToolArgs`（按 TOOLS 元数据：命名优先、位置按声明顺序补缺、必填校验）→ `runTool` → `echo()/now()` |
| MCP | 客户端 `tools/call {name, arguments}` → SDK 校验 zod schema → handler → **同一个** `echo()/now()` |

### 关键机制

1. **TOOLS 元数据是单一事实来源**：CLI 的子命令清单、参数帮助文案，MCP 的工具名/描述/参数 schema，全部从 core 的 `TOOLS: ToolMeta[]` 生成。两侧文案与行为**结构上不可能漂移**——新增工具只改 core 一处。
2. **core 零传输依赖**：不 import 任何 CLI/MCP/IO 库。这就是"逻辑一样、对外方式不同"能成立的原因：适配器只做协议翻译，不含业务。
3. **参数校验双层**：CLI 侧 `buildToolArgs` + `runTool` 校验（必填/类型）；MCP 侧 zod schema 由 SDK 在协议层校验。报错文案同源（`runTool` 的错误）。
4. **stdio 纪律**：MCP 模式下 **stdout 是 JSON-RPC 协议通道**，服务自身日志一律 `console.error`（stderr）。任何往 stdout 打日志的改动都会破坏协议。
5. **启动器发现机制**：仓库根 `bin/tool-launcher.js` 识别"workspace 布局"——工具目录下存在 `mcp/dist/index.js`（构建产物）即可被拉起，无需声明文件；缺产物时启动器自动 `install + tsc -b`。

## 使用步骤

### 步骤 0：前置与构建

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 18 |
| 包管理器 | pnpm（优先）或 npm（均支持 workspaces） |

```powershell
cd tools/server-a
npm install && npm run build        # 或 pnpm install && pnpm build
```

构建成功标志：`core/dist`、`cli/dist`、`mcp/dist` 三个目录出现。验证：

```powershell
node cli/dist/index.js list         # 能打印工具清单即成功
```

工作区 npm scripts：

| 命令 | 作用 |
| --- | --- |
| `npm run build` / `npm run clean` | 构建 / 清理（`tsc -b`，按 core→cli/mcp 顺序） |
| `npm run start:mcp` / `start:cli` | 直接启动对应适配器 |

### 步骤 1：CLI 使用

入口：`node cli/dist/index.js <命令> [参数...]`（下称 `cli`）。

**全局命令**：

| 命令 | 作用 | 预期输出 |
|---|---|---|
| `help` / `-h` / `--help`（或无参数） | 用法（工具清单自动生成） | 用法文本 |
| `-v` / `--version` | 版本 | `server-a-cli v0.1.0` |
| `list` / `-l` / `--list` | 工具清单 | 见下 |

```powershell
node cli/dist/index.js list
# [server-a] 可用工具：
#   - echo    原样返回输入的消息（server-a 示例工具）
#   - now     返回服务器当前时间（server-a 示例工具）
```

**工具命令与参数**：

| 命令 | 参数 | 类型 | 必填 | 预期输出 |
|---|---|---|---|---|
| `echo` | `message` | string | 是 | `[server-a] echo: <message>` |
| `now` | — | — | — | `[server-a] server time: <ISO 8601>` |

`echo` 三种等价传参（`--name value` / `--name=value` / 位置参数；命名优先）：

```powershell
node cli/dist/index.js echo "hello"                 # → [server-a] echo: hello
node cli/dist/index.js echo --message "hello"       # 同上
node cli/dist/index.js echo --message=hello         # 同上
node cli/dist/index.js now                          # → [server-a] server time: 2026-…T…Z
```

**退出码**：`0` 成功（含 help/list/version）；`1` 未知工具 / 缺必填参数（stderr 报错，如 `工具 "echo" 缺少 string 类型的必填参数 "message"`）。

**排错**：`Cannot find module '@ai-redfish/server-a-core'` → 没装依赖或没构建，重跑步骤 0。

### 步骤 2：MCP 使用

① 启动/注册（客户端配置，路径必须是构建产物的**绝对路径**）：

```json
{
  "mcpServers": {
    "server-a": {
      "command": "node",
      "args": ["D:/develop/GitNote/Redfish-AI/Tool/tools/server-a/mcp/dist/index.js"]
    }
  }
}
```

② 可用工具（`tools/list` 应返回这 2 个）：

| 工具 | 参数 | 类型 | 必填 |
|---|---|---|---|
| `echo` | `message` | string | 是 |
| `now` | — | — | — |

服务器信息：`name=server-a`，`version=0.1.0`；能力声明 `tools`。

③ 手动冒烟（PowerShell，不依赖客户端）：

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
'@ | node mcp/dist/index.js
# 第 2 帧应答应包含 echo / now
```

启动日志只在 stderr（`[server-a] MCP 服务已启动（stdio 传输）`）；stdout 无任何输出属正常（协议通道）。

### 步骤 3：仓库启动器（统一 MCP 入口）

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list             # 应列出 server-a
node bin/tool-launcher.js build server-a   # 只装依赖并构建（可选）
node bin/tool-launcher.js server-a         # 以 MCP stdio 拉起（缺 dist 自动构建）
```

拉起后进程常驻（stdio 服务不主动退出），Ctrl+C 结束。

### 步骤 4（可选）：全局安装 CLI 命令

```powershell
cd tools/server-a/cli
npm link                        # 或 pnpm link --global（需先 pnpm setup）

server-a-cli list               # 任意目录可用，行为与 node cli/dist/index.js 一致
server-a-cli echo --message=hi
npm rm -g @ai-redfish/server-a-cli    # 卸载（Windows 若 bin shim 残留手动删）
```

> 必须用 link 而非 `npm install -g .`：`@ai-redfish/server-a-core` 是未发布的 workspace 私有包，link 才能从仓库内解析依赖。链接指向源码，`cli/dist` 被删后需重新 `npm run build`。
