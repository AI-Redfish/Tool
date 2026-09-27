# server-a —— 多入口工具最小示例（TypeScript）

> 本仓库「一个工具，多种提供方式」约定的 TypeScript 参考实现：`core + cli + mcp` 三包工作区。
> 自带两个示例工具：`echo`（回显消息）、`now`（服务器 UTC 时间）。

## 底层实现原理

### 1. 分层：core 是唯一事实来源，适配器只做转发

```text
                 ┌─────────────────────────────┐
                 │ core（@ai-redfish/server-a-core）        │
                 │  · 纯业务函数 echo()/now()              │
                 │  · TOOLS 元数据（名称/描述/参数列表）      │
                 └──────────┬──────────────────┘
              ┌─────────────┴─────────────┐
   cli/src/index.ts                mcp/src/index.ts
   （argv 解析 → runTool）           （zod schema → 注册 handler）
```

- **core 零传输依赖**：不 import 任何 CLI/MCP/IO 库，只有纯函数 + 工具元数据（`ToolMeta[]`：name/description/params）。
- **TOOLS 元数据单一事实来源**：CLI 的子命令、参数帮助文案，MCP 的工具名/描述/zod schema，全部从同一份 `TOOLS` 生成——两侧文案与行为**结构上不可能漂移**（新增工具只需改 core 一处）。
- **统一分发入口 `runTool(name, args)`**：参数校验（必填/类型）失败抛带原因的错误，两个适配器共享同一套报错行为。

### 2. CLI 适配器（`cli/src/index.ts`）

极简 argv 解析，同时支持三种传参形式：`--name value`、`--name=value`、位置参数；`list` 子命令从 `TOOLS` 自动生成。错误统一写 stderr，退出码：0 成功 / 1 错误。

### 3. MCP 适配器（`mcp/src/index.ts`）

官方 `@modelcontextprotocol/sdk` + `StdioServerTransport`（stdio 传输）。**stdout 是 JSON-RPC 协议通道**，服务自身日志一律 `console.error`（stderr）。工具名/描述复用 `TOOLS`，参数用 zod 声明（运行时校验由 SDK 完成）。

### 4. 启动器如何发现它

仓库根 `bin/tool-launcher.js` 按「workspace 布局」识别：存在 `mcp/dist/index.js`（TypeScript 构建产物）即可以 MCP 方式拉起，无需任何额外声明文件。

## 接入方式与使用步骤

### 方式一：构建 + CLI

```powershell
cd tools/server-a
npm install && npm run build        # 或 pnpm install && pnpm build（需要 Node ≥ 18）
```

构建成功标志：各包出现 `dist/`（`core/dist`、`cli/dist`、`mcp/dist`）。常见问题：`Cannot find module '@ai-redfish/server-a-core'` = 没装依赖或没构建，重跑上面两步。

每条命令的预期输出：

```powershell
node cli/dist/index.js list                          # 列出工具
# [server-a] 可用工具：
#   - echo    原样返回输入的消息（server-a 示例工具）
#   - now     返回服务器当前时间（server-a 示例工具）

node cli/dist/index.js echo "hello"                  # → [server-a] echo: hello
node cli/dist/index.js echo --message "hello"        # 同上（命名参数）
node cli/dist/index.js echo --message=hello          # 同上（等号形式）
node cli/dist/index.js now                           # → [server-a] server time: 2026-…T…Z
node cli/dist/index.js echo                          # 缺必填参数 → stderr 报错，退出码 1
```

`list` 与帮助文案由 core 的 `TOOLS` 元数据自动生成，无需手动同步。

### 方式二：stdio MCP Server

直接拉起（MCP 客户端配置里指向构建产物）：

```powershell
node mcp/dist/index.js        # 启动后无 stdout 输出（stdout 是协议通道），启动日志在 stderr
```

在 MCP 客户端（Claude Desktop / pi 等）注册：

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

> 路径必须绝对路径且指向**构建后**的 `dist/index.js`；客户端不继承你的 shell 工作目录。

注册后可用工具：`echo`（参数 `message: string`）、`now`。验证方法：客户端连接后 `tools/list` 应返回这 2 个工具；手动冒烟可向进程 stdin 写一行 initialize JSON-RPC 观察应答（参见仓库内其它工具的 MCP 握手测试）。

异常排查：客户端连不上 → 先确认 `node mcp/dist/index.js` 能常驻不退出（报 MODULE_NOT_FOUND = 未构建/未装依赖）；stdio 模式下任何往 stdout 打日志的改动都会破坏协议，日志一律 `console.error`。

### 方式三：仓库统一启动器

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list                 # 确认识别 server-a（workspace 布局：存在 mcp/dist/index.js）
node bin/tool-launcher.js server-a             # 以 MCP 方式拉起（缺 dist 会先触发自动构建）
```

验证：`list` 输出应包含 `server-a`；拉起后进程常驻（stdio 服务不会主动退出），Ctrl+C 结束。

## 如何扩展一个新工具

1. `core/src/index.ts`：写纯函数 + 在 `TOOLS` 数组加一条元数据；
2. `mcp/src/index.ts`：按元数据注册 handler（zod schema 对齐参数类型）；
3. `cli/src/index.ts`：`runTool` 分发已自动覆盖（若用统一分发入口），无需改动；
4. `npm run build` 后两个入口同时生效。

## 文档导航

- 上层约定：[../README.md](../README.md)（工具目录结构与启动器协议）
- 同构 Python 实现：[../server-py/README.md](../server-py/README.md)
