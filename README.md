# AI-Redfish Tool 工具集合

当前项目是我的**工具集合项目**：提供一组开箱即用的工具。仓库根目录是一个「启动器」，`tools/` 目录下集中放置各个工具。

项目的核心设计：**每一个工具都可以以多种方式提供**——目前支持 **MCP Server** 与 **CLI 命令行**两种方式，后续可按需扩展更多方式（如 HTTP API、编辑器插件等）。所有方式共享同一份核心逻辑，行为完全一致。

用户通过一个统一入口（`npx github:AI-Redfish/Tool 工具名`）即可按需启动任意一个工具的 MCP 方式，无需单独安装、单独配置仓库。

## 设计理念：核心逻辑与提供方式分离

"逻辑一样、对外方式不同"是典型的核心逻辑与适配层分离场景——把业务逻辑沉到 `core`（纯函数/类），CLI、MCP 以及未来的新方式都只是不同的适配器：

```
                      ┌──────────────────────┐
                      │         core         │  纯函数 / 工具元数据（无任何传输依赖）
                      └──────────┬───────────┘
          ┌──────────────────┬───┴───────────┬──────────────┐
   ┌──────┴──────┐    ┌──────┴──────┐  ┌─────┴───────┐  ┌────┴────────┐
   │  cli 适配器  │    │  mcp 适配器  │  │ 更多提供方式  │  │ （未来扩展）  │
   │  命令行方式   │    │ stdio MCP   │  │ （按需增加）  │  │             │
   └─────────────┘    └─────────────┘  └─────────────┘  └─────────────┘
```

- **大幅减少重复代码**：业务实现只写一次，各适配器都是薄薄一层转发；
- **行为天然一致**：工具描述、参数、实现同源（core 的 `TOOLS` 元数据是单一事实来源）；
- **方便扩展**：新增一种提供方式只需新写一个适配器；改核心逻辑只动 `core`，互不影响。

## 目录结构

```
.
├── bin/
│   └── tool-launcher.js   # 启动器入口：解析参数 -> 按需安装/构建 -> 拉起工具入口
├── tools/                 # 所有工具（每个子目录 = 一个工具）
│   ├── server-a/          # TypeScript 三包工作区示例（echo / now）
│   │   ├── core/          # 核心逻辑：纯函数 + 工具元数据（@ai-redfish/server-a-core）
│   │   ├── cli/           # CLI 适配器（@ai-redfish/server-a-cli，bin: server-a-cli）
│   │   ├── mcp/           # MCP 适配器（@ai-redfish/server-a-mcp，stdio MCP Server）
│   │   ├── package.json   # server-a 工作区根（workspaces + build/start 脚本）
│   │   ├── pnpm-workspace.yaml
│   │   ├── pnpm-lock.yaml # 依赖锁文件（托管，保证 pnpm 安装可复现）
│   │   ├── .npmrc         # pnpm 的 link-workspace-packages=true
│   │   ├── tsconfig.base.json
│   │   └── tsconfig.json  # 工程引用入口（tsc -b 按 core -> cli/mcp 顺序构建）
│   └── server-py/         # Python 标准库示例（多语言演示，同样 core + cli + mcp 分层）
│       ├── core.py        # 核心逻辑：纯函数 + TOOLS 元数据
│       ├── cli.py         # CLI 适配器（argparse，子命令从 TOOLS 自动生成）
│       ├── mcp_server.py  # MCP 适配器（标准库手写 JSON-RPC；生产建议官方 SDK）
│       └── launcher.json  # 声明启动方式：{"command": "python", "args": ["mcp_server.py"]}
├── doc/                   # 项目文档（MCP 学习笔记等）
└── package.json           # 仓库根 package.json，只负责"启动器"这一件事
```

**git 托管边界**：托管的只有源码与配置（`src/`、`package.json`、`tsconfig*`、`pnpm-workspace.yaml`、`.npmrc`、锁文件、文档）；`node_modules/`、`dist/`、`*.tsbuildinfo`、`__pycache__/`、npm 回退生成的 `package-lock.json` 均为可再生内容，已在 `.gitignore` 中排除，克隆后由安装/构建步骤自动还原。

## 方式一：以 MCP Server 方式在客户端中使用（.mcp.json 配置）

把工具添加到 MCP 客户端的配置文件中：

```json
{
  "mcpServers": {
    "你的服务器名": {
      "command": "npx",
      "args": ["-y", "github:AI-Redfish/Tool"]
    }
  }
}
```

这个配置文件 `.mcp.json` 放到 `.agents` 的 `mcps` 目录下（即 `<你的项目根>/.agents/mcps/.mcp.json`）。

由于本仓库是"启动器 + 工具集合"结构，请通过 `args` 末尾追加工具名来指定要启动的工具，例如启动 `server-a`：

```json
{
  "mcpServers": {
    "你的服务器名": {
      "command": "npx",
      "args": ["-y", "github:AI-Redfish/Tool", "server-a"]
    }
  }
}
```

> 提示：不同的工具可以各配一条 `mcpServers` 条目，`args` 里写各自的工具名即可。

## 启动器用法

仓库根目录的 `package.json` 只做一件事：接收参数，然后动态加载 `tools/` 里的工具。用户运行：

```bash
npx github:AI-Redfish/Tool server-a
```

启动器会根据 `server-a` 参数：

1. 定位 `tools/server-a/` 目录；
2. 若依赖尚未安装（`node_modules` 缺失），自动执行 `pnpm install`（未装 pnpm 时回退 `npm install`）；
3. 若 MCP 入口尚未构建（`mcp/dist` 缺失），自动执行 `tsc -b` 构建；
4. 以子进程启动 `mcp/dist/index.js`，并透传 stdin/stdout（MCP stdio 协议通道）、stderr 及退出码。

> 安装与构建过程的日志全部被重定向到 stderr，不会污染 stdout 协议通道。

其他命令：

```bash
# 列出所有可用的工具
npx github:AI-Redfish/Tool list

# 手动安装并构建某个工具（开发调试用）
npx github:AI-Redfish/Tool build server-a

# 本地开发调试
npm run list
node bin/tool-launcher.js server-a
```

## 方式二：以 CLI 方式使用同一个工具（免安装，直接运行）

每个工具除 MCP 入口外，还自带一个 CLI 适配器，调用的是同一份核心逻辑。先构建，再用 node 直接运行：

```bash
cd tools/server-a
pnpm install            # 或 npm install
pnpm build              # 或 npm run build（实际执行 tsc -b）

node cli/dist/index.js list                 # 列出可用工具
node cli/dist/index.js echo "hello"         # 位置参数
node cli/dist/index.js echo --message hi    # 命名参数
node cli/dist/index.js now
npm run start:cli -- echo "hello"           # 等价写法
```

### 构建 CLI 并全局安装到本机

如果想在任何目录下直接敲 `server-a-cli` 命令，可以把 cli 包链接为全局命令。

**前置：先完成工作区的安装与构建**（全局命令运行的是 `cli/dist/index.js`，依赖也从工作区内解析）：

```bash
cd tools/server-a
pnpm install && pnpm build        # 或 npm install && npm run build
```

**方式一：npm link（推荐，node 自带 npm，零额外配置）**

```bash
cd tools/server-a/cli
npm link                          # 在 npm 全局目录创建 server-a-cli 命令，链接回本目录
```

之后在任意位置即可使用：

```bash
server-a-cli list
server-a-cli echo "hello"
server-a-cli now
```

> 为什么不能用 `npm install -g .`？因为 `@ai-redfish/server-a-core` 是 workspace 私有包，没有发布到 npm，直接全局安装会去 registry 找它而失败。`npm link` 只建立符号链接，依赖仍从仓库工作区内解析，所以能用。

**方式二：pnpm link --global**

```bash
cd tools/server-a/cli
pnpm link --global
```

> 前提：先执行过 `pnpm setup` 把 pnpm 的全局 bin 目录加入 PATH，否则命令不可见（会提示 `global bin directory is not in PATH`）。

**卸载全局命令**：

```bash
npm rm -g server-a-cli
# Windows 下若全局 bin 目录残留 server-a-cli / .cmd / .ps1 shim，手动删除即可
```

> 注意：链接方式的全局命令指向仓库内的源码位置。若删除了仓库或 `cli/dist` 构建产物，命令会失效，重新执行构建（`pnpm build`）即可恢复。

## 多语言支持：不止 Node

**MCP 协议本身与语言无关**：stdio 传输就是「每行一条 JSON-RPC 2.0 消息」，任何能读写 stdin/stdout 的语言都能实现。官方 SDK 覆盖 TypeScript/Python/Java/Kotlin/C#/Go/Rust 等，core + 适配器的分层模式也与语言无关。

当前仓库唯一与 Node 绑定的地方是启动器的默认约定（找 `mcp/dist/index.js` 用 node 拉起）。因此任何工具都可以放一个 `launcher.json` **声明自己的启动方式**：

```json
{
  "description": "一句话简介（list 时展示，可选）",
  "command": "python",                      // 启动命令，任意可执行程序
  "args": ["mcp_server.py"],                // 启动参数
  "setup": [["pip", "install", "-r", "requirements.txt"]]  // 可选：环境准备命令
}
```

- `npx github:AI-Redfish/Tool <名字>`：直接按声明拉起（stdin/stdout 照常透传，即 MCP stdio 通道）；
- `npx github:AI-Redfish/Tool build <名字>`：执行 `setup` 声明的环境准备命令（如 pip install、go build）；
- 客户端 `.mcp.json` 配置方式完全不变，使用者无感。

仓库内的 `server-py` 就是这样接入的：纯 Python 标准库（零第三方依赖）实现了与 server-a 同构的 core + cli + mcp 分层，同名工具 `echo` / `now`：

```bash
# CLI 方式
python tools/server-py/cli.py list
python tools/server-py/cli.py echo "hello"

# MCP 方式（客户端配置 args 改为 "server-py" 即可）
npx github:AI-Redfish/Tool server-py
```

> Go/Rust 这类编译型语言更简单：把二进制构建产物路径写进 `command`，把编译命令写进 `setup` 即可。

## 可用的工具

| 工具名 | 实现 | 说明 | 工具能力 | CLI 方式 |
| --- | --- | --- | --- | --- |
| `server-a` | TypeScript | core + cli + mcp 三包工作区示例 | `echo`、`now` | `server-a-cli`（可全局安装） |
| `server-py` | Python（纯标准库） | 多语言演示，与 server-a 同构分层 | `echo`、`now` | `python tools/server-py/cli.py` |
| `jev-desktop` | Python（uiautomation/mss/httpx） | Windows 桌面软件控制：UIA 语义树 + 截图/OCR/视觉三档观察，Jev 判断 + 规划 LLM，`execute`/`run` 双模式 | `desktop_doctor/windows/snapshot/act/execute/run/screenshot/clipboard` | `python tools/jev-desktop/cli.py` |

## 规划中的工具

- **jev-browser**：Playwright + Jev 浏览器控制，支持 `execute` / `run` 两种模式，以及 MCP、CLI、HTTP API 入口；默认授权接管日常 Chrome、有头运行。核心已实现（62 个离线测试通过），**P0 实机验证未完成，暂不可用**。
  详见 [方案总览](tools/jev-browser/README.md)、[技术设计](tools/jev-browser/DESIGN.md)、[开发计划](tools/jev-browser/DEVELOPMENT_PLAN.md)。
- **jev-desktop**：LLM 规划 + Jev 判断的 Windows 桌面软件控制（Python 实现），UIA 语义树 + 截图/OCR/视觉三档可降级观察，`execute` / `run` 双模式共用执行引擎，MCP 与 CLI 入口。**已实现并通过本地端到端验证，已加入可用工具列表**（P0 六应用实测矩阵与 P6 基准项后续推进；需 Windows 原生环境 + `pip install -r tools/jev-desktop/requirements.txt`）。
  详见 [方案总览](tools/jev-desktop/README.md)、[技术设计](tools/jev-desktop/DESIGN.md)、[开发计划](tools/jev-desktop/DEVELOPMENT_PLAN.md)、[研究记录](tools/jev-desktop/RESEARCH.md)。
- **jev-browser** 未通过实机验收，暂不可用；jev-desktop 的 P0 实测矩阵仍在推进。

## 如何新增一个工具

1. 在 `tools/` 下新建子目录（目录名即工具名，只允许字母、数字、`.`、`_`、`-`）：
   - **TypeScript（默认约定）**：按 `server-a/` 的 `core|cli|mcp` 结构搭建（整目录复制后改名）；
   - **其他语言**：只需一个 `launcher.json` 声明 `command`/`args`，分层随意（见「多语言支持」）；
2. 在 `core` 中实现纯函数，并登记到 `TOOLS` 元数据；
3. 在 `mcp` 适配器中注册（描述复用 `TOOLS` 元数据）；CLI 适配器无需改动——用法、`list`、参数校验都由 `TOOLS` 自动生成；
4. 后续想增加新的提供方式（如 HTTP API）：在同一目录下新增一个适配器包，调用同一个 `core` 即可；
5. 在工具根目录写好 `package.json`/`launcher.json` 的 `description`（启动器 `list` 会展示）；
6. 运行 `npx github:AI-Redfish/Tool build <名字>` 构建并确认。

详见 [tools/README.md](tools/README.md)。

## 注意事项

- stdio 传输下 **stdout 是 MCP 协议通道**：无论是启动器还是工具入口，日志都必须输出到 stderr（`console.error`），否则会破坏协议通信；CLI 适配器没有这个限制，结果正常打印到 stdout；
- 启动器只负责分发（安装/构建/拉起），不包含任何业务逻辑；业务能力全部在各工具的 `core` 内实现；
- 子工具通过环境变量 `TOOL_NAME` 可获知自己的工具名；
- TypeScript 工具需要Node.js >= 18；安装/构建优先使用 pnpm，未安装时自动回退 npm。
