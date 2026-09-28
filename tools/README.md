# tools/ —— 工具目录

本目录存放各个工具。项目的目的：**提供工具集合，且每一个工具都可以以多种方式提供**（MCP、CLI，后续可扩展更多），所有方式共享同一份核心逻辑。

工具不限于 Node 实现：

- **TypeScript（默认约定）**：每个子目录是一个独立的 **core + cli + mcp 三包工作区**（pnpm/npm workspace + TypeScript 工程引用），例如 `server-a`；
- **任意语言**：在子目录放一个 `launcher.json` 声明启动方式即可被启动器拉起，例如 `server-py`（纯 Python 标准库，与 server-a 同构的 core + cli + mcp 分层）。

## 已实现工具

- [`server-a/`](server-a/README.md)：多入口工具最小示例（TypeScript，`core + cli + mcp` 三包工作区，echo/now），本目录分层约定的参考实现。
- [`server-py/`](server-py/README.md)：同构 Python 标准库版（`core.py + cli.py + mcp_server.py` + `launcher.json`），演示任意语言工具接入。
- [`jev-browser/`](jev-browser/README.md)：浏览器控制工具（Playwright + Jev，`core + cli + mcp + api` 四包工作区，execute/run 双模式共用执行引擎）。**核心已实现**：62 个离线测试通过；launch 路径（受管 Chromium）端到端冒烟通过（`scripts/smoke.mjs`）；attach 接管日常 Chrome 待用户授权后专项验证（见 [docs/compatibility.md](jev-browser/docs/compatibility.md)），此前勿用于生产。
- [`jev-desktop/`](jev-desktop/README.md)：Windows 桌面控制工具（UIA 观察 + Jev 判断 + 规划 LLM，Python 实现 `core + cli + mcp` + `launcher.json`）。**已实现并通过本地端到端验证**（离线测试/真实窗口快照/execute 全链路/Jev mock 联调/MCP 协议，见其 README 实机验证记录）；SendInput 输入类动作待真人监督实测，OCR 为可选依赖。

阅读顺序（两者同构）：[方案总览](jev-browser/README.md) → [技术设计](jev-browser/DESIGN.md) → [开发计划](jev-browser/DEVELOPMENT_PLAN.md) → [兼容性验证](jev-browser/docs/compatibility.md)；事实依据见 [RESEARCH](jev-browser/RESEARCH.md) / [jev-desktop RESEARCH](jev-desktop/RESEARCH.md)。

## TypeScript 工具的目录结构（以 server-a 为例）

```
tools/
└── server-a/                  # 工具名（即启动器参数）
    ├── core/                  # 核心逻辑：纯函数 + 工具元数据（无任何传输依赖）
    │   ├── src/index.ts
    │   ├── package.json       # @ai-redfish/server-a-core
    │   └── tsconfig.json
    ├── cli/                   # CLI 适配器：把 core 工具暴露为命令行命令
    │   ├── src/index.ts
    │   ├── package.json       # @ai-redfish/server-a-cli（bin: server-a-cli）
    │   └── tsconfig.json
    ├── mcp/                   # MCP 适配器：把 core 工具暴露为 stdio MCP Server
    │   ├── src/index.ts
    │   ├── package.json       # @ai-redfish/server-a-mcp
    │   └── tsconfig.json
    ├── package.json           # 工作区根（workspaces、build/start 脚本、typescript devDep）
    ├── pnpm-workspace.yaml    # pnpm workspace 定义（npm 用户走 package.json 的 workspaces 字段）
    ├── pnpm-lock.yaml         # 依赖锁文件（托管）
    ├── .npmrc                 # pnpm 的 link-workspace-packages=true
    ├── tsconfig.base.json     # 共享编译选项
    └── tsconfig.json          # 工程引用入口（tsc -b 按依赖顺序构建）
```

## 为什么要这样分层

"逻辑一样、对外方式不同"是典型的核心逻辑与适配层分离场景：

- `core` 只写一次纯函数与工具元数据（`TOOLS`），不感知 MCP 协议或命令行；
- `mcp` 适配器只做协议注册（zod schema + handler 转发到 core）；
- `cli` 适配器只做参数解析（依据 `TOOLS` 自动生成帮助与校验，转发到 core）；
- 未来新增提供方式（如 HTTP API）：在工具目录下再加一个适配器包，调用同一个 `core` 即可。

收益：新增工具只写一次核心实现；所有入口行为天然一致；重复代码趋近于零。

## 本地开发

```bash
cd tools/server-a
pnpm install            # 或 npm install（两者都支持 workspaces）
pnpm build              # 或 npm run build（实际执行 tsc -b，按 core -> cli/mcp 顺序构建）

# MCP 方式（stdio）
node mcp/dist/index.js

# CLI 方式（调用的是同一批工具）
node cli/dist/index.js list
node cli/dist/index.js echo "hello"
node cli/dist/index.js echo --message hello
```

也可以从仓库根目录让启动器代劳（自动 install + build + 启动）：

```bash
node bin/tool-launcher.js server-a        # MCP 方式
node bin/tool-launcher.js build server-a  # 只安装并构建
```

## 全局安装 CLI 命令

想在任意目录直接使用 `server-a-cli`，在构建完成后用 link 方式安装（不能用 `npm install -g .`，因为 `@ai-redfish/server-a-core` 是未发布的 workspace 私有包，link 才能让依赖从仓库内解析）：

```bash
cd tools/server-a/cli
npm link             # 或 pnpm link --global（需先 pnpm setup）

server-a-cli list    # 任意目录可用
npm rm -g server-a-cli   # 卸载（Windows 下若 bin shim 残留，手动删除）
```

链接指向仓库内源码，若 `cli/dist` 被删除需重新构建后命令才可用。

## 多语言工具（launcher.json）

任意语言实现的工具，在子目录放一个 `launcher.json` 即可被启动器拉起：

```
tools/
└── server-py/
    ├── core.py               # 核心逻辑：纯函数 + TOOLS 元数据
    ├── cli.py                # CLI 适配器（argparse，子命令从 TOOLS 自动生成）
    ├── mcp_server.py         # MCP 适配器（标准库手写 JSON-RPC；生产建议官方 SDK）
    └── launcher.json         # {"command": "python", "args": ["mcp_server.py"]}
```

`launcher.json` 字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 是 | 启动命令（任意可执行程序，如 `python`、`./server-go`） |
| `args` | 否 | 启动参数数组（客户端透传的额外参数会追加在后面） |
| `description` | 否 | 一句话简介（启动器 `list` 展示） |
| `setup` | 否 | 环境准备命令数组（如 `["uv","sync"]`，Python 工具经 uv 建 .venv），由 `build` 子命令触发 |

## 新增一个能力（工具的某个功能，以 server-a 为例）

1. `core`：实现纯函数（如 `hello()`），并在 `TOOLS` 中登记名称/描述/参数；
2. `core`：在 `runTool` 的分发中补一个 case；
3. `mcp`：用 `server.tool(...)` + zod 注册，名称与描述复用 `TOOLS` 元数据，handler 调用 core 函数；
4. `cli`：无需改动——用法、`list`、参数校验全部由 `TOOLS` 自动生成；
5. 重新构建：`pnpm build`（或仓库根 `node bin/tool-launcher.js build server-a`）。

## 新增一个工具

1. 复制 `server-a/`（TypeScript）或 `server-py/`（其他语言）为新目录（目录名即工具名，只允许字母、数字、`.`、`_`、`-`）；
2. TypeScript：全局替换包名 `@ai-redfish/server-a-*` 与 core 中的 `SERVER_NAME`；
3. 在工具根 `package.json`/`launcher.json` 的 `description` 写一句话简介（启动器 `list` 会展示）；
4. `node bin/tool-launcher.js build <名字>` 构建并确认。

## 注意事项

- stdio 传输下 **stdout 是 MCP 协议通道**：无论何种语言，MCP 适配器自身的日志必须写 stderr；CLI 适配器没有这个限制，结果正常打印到 stdout；
- 非 UTF-8 默认编码的语言/平台（如 Windows 上的 Python）注意强制 stdout 为 UTF-8，参见 server-py 的做法；
- 工具通过环境变量 `TOOL_NAME` 可获知自己的工具名；
- TypeScript 工具需要Node.js >= 18；包管理器优先 pnpm，未安装时回退 npm（两种管理器都支持 workspaces）。
- Python 工具的环境统一由 uv 管理：`uv sync` 在工具目录创建隔离的 `.venv`（依赖声明在 `pyproject.toml`，OCR 等可选依赖用 `--extra`），`uv run` 运行（launcher.json 的 command/setup 同理）；不直接使用 pip，缺 uv 时先安装（https://docs.astral.sh/uv/）。
