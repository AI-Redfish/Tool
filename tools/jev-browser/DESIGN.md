# jev-browser 技术设计

> 版本：设计草案 v0.2；复核日期：2026-09-24。
> 本文件描述计划实现的能力，不代表已有代码或通过实测的性能。资料编号见 [RESEARCH.md](RESEARCH.md)。

## 1. 需求与成功标准

### 1.1 已确认需求

1. 在本仓库新增一个工具，遵循现有分层、启动器和日志规范。
2. 使用 Playwright 操作浏览器、Jev 判断页面；参考 Ying-Kai-Liao/jev-browser。
3. 默认接管已打开的日常 Google Chrome，复用其标签页和登录状态，默认有头。
4. 可通过环境变量或配置文件切换无头、Playwright 管理的 Chromium。
5. 同时支持 Agent/MCP、CLI、HTTP API；入口不决定任务规划方式。
6. 支持 `execute`（外部已有计划）与 `run`（工具内部规划），共用执行引擎。
7. 优先保证稳定、保护用户会话，再比较可靠完成同一任务的端到端耗时。
8. 当前先交付开发计划与设计，不直接实现或修改用户浏览器。

### 1.2 首版范围

- 导航、标签页选择、紧凑页面快照、点击、输入、按键、选择、滚动、等待、提取、断言、截图。
- 上传/下载、iframe、开放 Shadow DOM、弹窗和 JS dialog 的受限支持及明确能力探测。
- 连续步骤、单一目标的局部循环、可选完整任务规划、暂停/确认/恢复/取消、限额与可观测性。
- Windows 原生运行优先；其他系统和跨 WSL 连接列为兼容性测试，不以路径转换假定可用。

首版不做：验证码绕过、规避站点风控、任意桌面控制、任意脚本执行入口、无限自主循环、通用视觉 Agent、远程多租户 SaaS、自动复制 Chrome 主 profile、承诺所有网站成功。

按纵向能力交付，避免先做一个通用工作流平台：最小可用版保留三入口、A/B 共用、顺序步骤与有界遍历，先验证只读页面任务和下载任务。首版的写操作只允许确定性、可验证且风险低的动作；发送、购买、付款、删除、权限变更等动作统一返回 `paused + needs_confirmation`，等可信审批通道完成后再实现。跨 profile 并行、任意嵌套流程、跨宿主迁移、事件流推送和视觉兜底后置；核心鉴权、串行、取消、人工暂停、结果验证不能后置。高级页面能力按 capability 明示，不能为了凑首版清单把未验证项都标为支持。

## 2. 架构决策

### ADR-01：可选规划器，而不是两套浏览器引擎

```text
Agent/MCP        CLI             HTTP API
    │             │                 │
    └─────────────┼─────────────────┘
             ToolRegistry / schemas
                      │
                  TaskService
           ┌──────────┴──────────┐
        execute                 run
      输入已知步骤         PlannerProvider（可选）
           └──────────┬──────────┘
                 FlowExecutor
                      │
         ActionExecutor / GoalExecutor
                      │
      Observation → Jev → Policy → Playwright
                      │
           Verification / TaskStore / Metrics
                      │
              BrowserSessionManager
```

- `execute` 永不暗中调用规划大模型。确定性步骤可零模型调用；语义目标可以多次调用 Jev。
- `run` 接收完整目标，按需生成短计划；计划步骤仍交给同一个 FlowExecutor。
- Jev 处理闭集选择、是/否判断和结构化概率，不承担自由文本计划生成。[S7—S10]
- 同一阶段只有一个规划负责人。外部 Agent 调用 `run` 后等待结果/异常，不并行操纵同一任务页面。
- 不新增一次模型请求来猜 A/B；调用者显式选择入口。

### ADR-02：浏览器连接与执行分离

同一执行引擎支持三种明确配置：

| 配置 | 行为 | 登录状态 | 适用场景 |
| --- | --- | --- | --- |
| `attach + chrome`（默认） | 授权后连接已经运行的日常 Chrome | 复用所连接 context 的登录状态 | 日常浏览器接管 |
| `launch + chrome` | 启动本机安装的 Chrome，使用工具独立目录 | 独立、可持久化；不是原日常登录状态 | 隔离自动化、可选无头 |
| `launch + chromium` | 启动 Playwright 管理的 Chromium | 独立、可持久化 | 可重复测试、可选无头 |

“真实 Chrome”是浏览器品牌/安装来源；“接管或启动”是连接方式；“有头或无头”是启动显示方式。三个维度不能混为一谈。

### ADR-03：复用上游思想，重新实现本仓库边界

吸收页面语义建模、候选选择、每轮多问题判断、诚实的异常状态；不直接包裹上游 `launch()/close()`：上游接受 browser 后仍会 `newContext()`，其 `close()` 会关闭 context，不符合保留日常会话的要求。[S2]

优先以 TypeScript 重新实现边界与状态机。若移植任何上游代码，保留对应许可、作者及版本出处；版本升级用测试评估，不追踪浮动源码。[S1]

## 3. 仓库组织与技术基线

拟议目录：

```text
tools/jev-browser/
├── README.md / DESIGN.md / DEVELOPMENT_PLAN.md / RESEARCH.md
├── core/
│   └── src/
│       ├── index.ts                 # 公共 API
│       ├── registry.ts / schemas.ts # 工具元数据、输入输出、JSON Schema
│       ├── config/                  # 合并、校验、来源诊断
│       ├── browser/                 # attach/launch、所有权、能力探测、互斥
│       ├── observation/             # frames、候选、差量、状态版本
│       ├── execution/               # action、goal、flow、verification
│       ├── jev/                     # 官方 SDK 的窄适配
│       ├── planner/                 # 可选 PlannerProvider
│       ├── safety/                  # 域名/文件/副作用/数据外发策略
│       └── runtime/                 # TaskService、状态、预算、日志、取消
├── cli/src/index.ts
├── mcp/src/index.ts
├── api/src/index.ts
├── tests/{unit,integration,e2e,fixtures}/
├── bench/                          # 可重置任务、计时和结果，不含账号
├── examples/                       # 无敏感信息的配置与流程
├── package.json / pnpm-workspace.yaml / pnpm-lock.yaml / .npmrc
└── tsconfig.base.json / tsconfig.json
```

- 延续 `core + cli + mcp`，新增 `api` workspace；`tsc -b` 构建依赖顺序为 core → 适配器。
- 包名使用 `@ai-redfish/jev-browser-core`、`-cli`、`-mcp`、`-api`；CLI bin 拟为 `jev-browser-cli`，避免和上游命令混淆。
- core 不导入 CLI 解析、MCP 或 HTTP 框架；使用注入的 browser、planner、judge、clock、logger 端口。浏览器操作本来有副作用，不把它误称为纯函数。
- `TOOLS` 同时携带名称、描述、schema、风险标签、handler；CLI/MCP/API 从同一注册表派生，不复制三份校验逻辑。
- 不照抄 `server-a` 仅支持 string 的参数系统；扩展对象、数组、枚举与异步返回，但不修改示例工具。
- 技术候选：Node.js 24.x、TypeScript、Playwright 1.63.0、官方 `@typesafe-ai/sdk`、官方 MCP TypeScript SDK。这是拟验证基线，不强迫仓库其他工具升级。[S6、S7]
- P0/P1 锁定验证过的准确版本，提交 pnpm 锁文件；pnpm 优先，npm 回退单独测试，私有包不使用会破坏 npm 回退的依赖写法。
- 根启动器保持只安装、构建、分发；新增工具仍使用 `mcp/dist/index.js`。API 和 CLI 从各自入口启动，不塞入根启动器业务。
- 浏览器下载是显式 setup，不在默认接管时自动下载 Chromium。构建、安装和 MCP 日志只写 stderr。

## 4. 默认接管日常 Chrome

### 4.1 推荐路径（P0 验证后启用）

1. 用户运行 Chrome，并在 `chrome://inspect/#remote-debugging` 开启调试授权。Chrome 官方说明该机制适用于 144 及以上版本；实际仍检查本机版本、策略和授权。[S3]
2. 工具通过 Playwright CDP 连接日常实例。固定版本实现中可将 `chrome` channel 解析到端点；优先做版本契约测试，不依赖内部私有模块。[S5]
3. 显式端点通过本地可信配置覆盖；默认只接受 loopback，禁止由页面或模型提供 CDP 地址。
4. 使用已有默认 context。不得 `newContext()` 代替复用登录态，不批量导出 Cookie。
5. 连接参数优先 `noDefaults: true`，减少对下载、焦点和媒体设置的默认覆盖。其能力影响也要测试，尤其下载。[S4]
6. 每个会话显式选择 `pageId`。没有指定且有多个候选时返回 session 状态 `awaiting_page` 和最少必要的页面元数据，不猜“第一张就是当前页”，此时还没有任务需要暂停。
7. 可以显式请求新建标签页，但仍属于原 context；不默认导航/覆盖用户未选中的标签页。

连接示意（尚未验证，不能视为已可运行工具）：

```ts
const browser = await chromium.connectOverCDP("chrome", {
  noDefaults: true,
  timeout: 60_000,
});
const context = browser.contexts()[0];
// 由 SessionManager 处理 context 缺失、页面选择、租约和 capability 探测。
// 禁止对这个借用的 context 调用 close()。
```

`chrome` 的自动发现由固定版本实现证实，但 endpointURL 文档主要承诺 URL；必须记录这一兼容风险。若 channel 发现失败，可让用户显式提供已授权端点；不扫描外网/所有端口，不引入未经验证的内部 API。

### 4.2 为什么不默认扩展或传统调试启动参数

| 路径 | 本方案定位 | 原因与边界 |
| --- | --- | --- |
| 原生授权调试 + Playwright CDP | 默认候选 | 不增加扩展/桥接进程；契合真实会话。这里只是减少组件的设计判断，未证明绝对最快 |
| 启动 Chrome 时加调试端口 | 显式备用 | Chrome 136 起默认用户数据目录受限制，不能保证接管原日常 profile。[S3] |
| 扩展 + 本地桥接 | 后续兼容候选 | 可另行评估，但增加安装、权限、升级和桥接测试；不凭空宣称能兼容全部 Playwright API |
| Playwright 自行启动浏览器 | 隔离备选 | 工具控制启动生命周期，但默认不拥有日常登录态，不能静默替换 |

官方明确 CDP 连接相较 Playwright 协议连接保真度较低；所以“保留日常浏览器”与“最大限度的自动化可控性”存在取舍，不能声称 CDP 在所有场景最稳定。[S4]

### 4.3 所有权与退出

维护 `browserOwnership/contextOwnership/pageOwnership = borrowed | owned`：

- attach 的 browser/context 为 borrowed；已有页也是 borrowed。
- attach 中新建页可记 owned，但默认保留，只有显式清理时关闭工具创建的页。
- session `disconnect` 先检查任务：仍有 running/queued/cancelling 任务时返回 `SESSION_BUSY`；paused 任务可以使用显式 `detachTask=true` 断开，任务转为 `paused/interrupted`，持久化 profile 预约和 resume 期限，并保留原 pendingAction/审批要求。没有该标志时 paused 也返回 `SESSION_BUSY`。最后一个 session 释放后才关闭共享 CDP 连接；不能一个 session 断开把同宿主其他 session 都断开。清理只移除本工具监听器/observer/进程租约，不删除任务预约或隔离记录，不得执行借用 context.close、Browser.close CDP 命令或杀 Chrome 进程。
- Playwright 连接对象的连接级清理必须按固定版本验证其真实效果，不能仅依据方法名判断是否关浏览器；P0 检查进程、页和登录态全部保留。[S5]
- launch 的实例可由工具关闭；每个 engine 使用不同的工具 profile（例如 `profiles/chrome/default` 与 `profiles/chromium/default`），绝不让两个引擎写同一目录，也不使用 Chrome 主目录启动第二个写入进程。只清理有工具所有权标记的临时目录，用户指定的持久化目录不自动删除。
- 人工关闭标签页、切换账号、导航或与自动化冲突时，旧候选失效，返回 `needs_input` 或重新观察，不在错误账户上继续。
- CDP 连接意外断开（用户中途关闭 Chrome、浏览器崩溃、调试授权被撤销）时：立即停止观察、操作和模型外发；任务转 `paused/interrupted`，在途 artifact 按 S13 核查完整性；绝不自动启动替代浏览器、不自动重连抢注，恢复由用户显式触发。P0 必须覆盖该场景，因为它在接管日常浏览器时不可避免。

### 4.4 弹窗与未选中页面的非干扰边界

Playwright 默认可能自动 dismiss JS dialog；注册 listener 后又必须处理，否则触发操作可能挂住。因此“只在选中页执行 click”不等于接管对其他页完全无影响。[S12]

- P0 必须在两个测试标签页验证未选中页的 alert/confirm/prompt/beforeunload；确认工具不自动替用户作选择、原生人工处理仍可用。`noDefaults` 不是此行为的保证。若当前 Playwright/CDP 组合无法实现保留，默认接管不得通过保护性门槛，明确报告限制并重新选择路径。测试应记录对话框展示和用户接受/拒绝后的页面结果，不能仅凭“进程没有挂住”判定成功；阻塞原生 JS 对话框不能要求页面脚本自行关闭。
- 被授权动作的 dialog handler 在动作前注册，由预定 dialogPolicy 处理；已授权的预期 confirm 才允许接受。未知 confirm/prompt 保守拒绝并记录 `paused/needs_confirmation`，beforeunload 默认保留当前页；不得在被阻塞的同一调用中等待一个可能永远不来的模型批准。
- dismiss 可能已经产生页面副作用；恢复时先重新观察，不重新点击原动作。未选中页不注入观察脚本、不统一安装自动接受/拒绝策略。

### 4.5 Windows 与 WSL

建议工具 Node 进程与 Chrome 同在 Windows 原生环境。WSL 的 localhost、文件系统与 Windows 并不视为同一个环境：不得自动读取 Windows 主 profile 并用 Linux 路径推断连接。跨环境端点、上传和下载路径都需单独映射与验证。P0 未通过时明确报不支持，不设置虚假的 `isLocal: true`。

## 5. 配置设计

### 5.1 来源、优先级与校验

- 常规配置优先级：CLI 显式参数 > 环境变量 > 选中的 JSON 文件 > 默认值。
- 文件选择：`--config` > `JEV_BROWSER_CONFIG` > 用户配置目录中的 `config.json`。不从不可信项目目录自动加载凭据或执行 JS 配置。
- 用户目录：Windows `%LOCALAPPDATA%\AI-Redfish\jev-browser`；其他系统采用平台标准用户配置/数据目录，不写入 npx 缓存。
- 配置文件内相对路径按该文件所在目录解析；直接 CLI 的相对参数按其进程 cwd 解析。环境变量里的配置/数据/profile 路径要求绝对路径；经仓库启动器启动时也使用绝对路径，不假定能还原启动器调用者原始 cwd。
- 根启动器改变 cwd，不依赖 cwd 找仓库 `.env`；默认不自动读取 `.env`。显式 env-file 作为未来可选功能。
- HTTP/MCP 任务只接受白名单的任务级覆盖，不能覆盖服务器 token、模型 key、CDP 端点、文件根目录或安全策略；任务只能收紧全局策略。
- 布尔值仅接受 `true/false/1/0`，不以字符串 truthy 判断；拒绝未知字段和冲突配置。
- `doctor` 给出脱敏后的有效值和来源；绝不打印 secret 值。

### 5.2 主要配置字段

| 文件字段 | 环境变量 | 默认 / 说明 |
| --- | --- | --- |
| `browser.mode` | `JEV_BROWSER_MODE` | `attach`；另有 `launch` |
| `browser.engine` | `JEV_BROWSER_ENGINE` | `chrome`；另有 `chromium` |
| `browser.headless` | `JEV_BROWSER_HEADLESS` | `false`；attach + true 直接配置错误 |
| `browser.attach.endpoint` | `JEV_BROWSER_CDP_ENDPOINT` | attach 缺省解析为 `chrome`；也支持可信配置中的 loopback URL |
| `browser.attach.noDefaults` | `JEV_BROWSER_NO_DEFAULTS` | attach 默认 true |
| `browser.attach.timeoutMs` | `JEV_BROWSER_CONNECT_TIMEOUT_MS` | 拟定 60000，含浏览器授权等待，待 P0 调整 |
| `browser.launch.userDataDir` | `JEV_BROWSER_USER_DATA_DIR` | launch 缺省为按 engine 分离的工具独立 profile，并加锁 |
| `browser.launch.timeoutMs` | `JEV_BROWSER_LAUNCH_TIMEOUT_MS` | 拟定 30000，启动超时 |
| `browser.launch.chromiumSandbox` | `JEV_BROWSER_CHROMIUM_SANDBOX` | 拟定 true；无法启用则诊断失败，不静默关闭 |
| `jev.model` | `JEV_BROWSER_JEV_MODEL` | `jev-latest`；记录服务实际返回 model，基准测试固定模型版本 |
| `jev.apiKeyEnv` | — | 默认引用 `TYPESAFE_API_KEY`，文件里不放真实 key |
| `planner.enabled` | `JEV_BROWSER_PLANNER_ENABLED` | `false`；run 需显式启用并配置 |
| `planner.provider` | `JEV_BROWSER_PLANNER_PROVIDER` | 无默认厂商；由已实现 Provider 名称选择 |
| `planner.baseUrl` | `JEV_BROWSER_PLANNER_BASE_URL` | 无默认；仅可信本地配置，禁止任务覆盖 |
| `planner.model` | `JEV_BROWSER_PLANNER_MODEL` | 无默认，明确指定 |
| `planner.apiKeyEnv` | — | 默认引用 `JEV_BROWSER_PLANNER_API_KEY` |
| `runtime.dataDir` | `JEV_BROWSER_DATA_DIR` | 平台用户数据目录，非仓库 |
| `runtime.timeoutMs` | `JEV_BROWSER_TIMEOUT_MS` | 拟定 180000；任务只可缩短 |
| `runtime.maxSteps` | `JEV_BROWSER_MAX_STEPS` | 拟定 100，包含实际展开步骤；开发初值 |
| `runtime.maxActions` | `JEV_BROWSER_MAX_ACTIONS` | 拟定 60，开发初值 |
| `runtime.maxReplans` | `JEV_BROWSER_MAX_REPLANS` | 拟定 3，开发初值 |
| `runtime.maxJevRequests` | `JEV_BROWSER_MAX_JEV_REQUESTS` | 拟定 100；包含重试和分层选择 |
| `runtime.maxPlannerRequests` | `JEV_BROWSER_MAX_PLANNER_REQUESTS` | 拟定 8；包含首次规划、重规划、修正和重试 |
| `runtime.maxInputTokens` | `JEV_BROWSER_MAX_INPUT_TOKENS` | 拟定 200000；两类模型累计，开发初值 |
| `runtime.maxOutputTokens` | `JEV_BROWSER_MAX_OUTPUT_TOKENS` | 拟定 20000；两类模型累计，开发初值 |
| `runtime.queueTimeoutMs` | `JEV_BROWSER_QUEUE_TIMEOUT_MS` | 拟定 60000；排队独立计时 |
| `runtime.pauseTtlMs` | `JEV_BROWSER_PAUSE_TTL_MS` | 拟定 900000；暂停后最多等待 15 分钟 |
| `runtime.taskTtlMs` | `JEV_BROWSER_TASK_TTL_MS` | 拟定 1800000；自受理起的绝对有效期 |
| `safety.allowedOrigins` | `JEV_BROWSER_ALLOWED_ORIGINS` | 空数组；环境值须为 JSON 字符串数组，只允许明确的 http/https origin |
| `safety.modelOrigins` | `JEV_BROWSER_MODEL_ORIGINS` | 空数组；必须是 allowedOrigins 的子集，控制页面数据外发 |
| `safety.approvalTtlMs` | `JEV_BROWSER_APPROVAL_TTL_MS` | 拟定 120000；授权签发后两分钟内有效 |
| `api.host` | `JEV_BROWSER_API_HOST` | `127.0.0.1`；首版只接受 loopback |
| `api.port` | `JEV_BROWSER_API_PORT` | `3737`；端口冲突报错，不静默漂移 |
| `api.tokenEnv` | — | 引用 `JEV_BROWSER_API_TOKEN`；HTTP 启动时必须存在 |

attach 与 launch 分别置于子对象，允许同一配置文件保存两套参数。逐字段按来源合并、校验已配置字段的类型，再只激活当前 mode 的分支；`doctor` 显示非活动字段但不使用，也不因为另一分支存在就报冲突。未知字段仍报错，旧草案的顶层 `cdpEndpoint/noDefaults/userDataDir/connectTimeoutMs` 不接受并提示新路径。这样只改三项环境变量即可切换 Chromium/headless，无需修改原 attach 配置。`attach + chromium` 首版不支持，`attach + headless=true` 仍报错，不隐式切换实例。

配置校验分两层：格式错误始终拒绝；凭据/服务可用性按实际能力惰性检查。缺 planner 配置只阻止 run，缺 Jev key 只阻止语义步骤，不妨碍 doctor 或纯确定性 execute。被启动的浏览器采用显式环境白名单，不继承 API key、审批密钥和全部服务环境变量；沙箱需显式启用并在目标 Windows 环境验证。[S4]

`headless=true` 只控制新进程启动。对于 attach，`false` 表示默认连接有头日常实例的预期，不是强行改变已运行进程；若无法确认实际显示模式，doctor 如实报告未知。

## 6. 执行循环与 Jev 设计

### 6.1 四条执行规则

1. **确定性动作优先**：准确定位器 + 参数 + 验证条件 → Playwright，不调用模型。
2. **语义目标局部循环**：观察 → Jev 选择 → 策略校验 → 执行 → 再观察/验证；一个 goal 对应一个可观察结果。
3. **代码验证优先**：URL、数量、文件出现、字段值、排序等能计算的事实由代码检查。
4. **不确定就暂停**：没有充分证据不输出 done；`likely_done` 不是成功，不自动进入下一项有副作用步骤。

### 6.2 页面状态与候选

只采集授权页及必要 frame，生成 role/name、可见文本、标签关系、disabled/checked/selected、遮挡提示、URL、计数、变化摘要。密码值、Cookie、token、隐藏凭据不进入模型 state。

- 候选带 `sessionId/pageId/frameId/snapshotId/elementId`；ID 仅在该快照有效，不持久化为网页选择器。
- 执行前检查页面、frame、URL/账号上下文和相关元素指纹；不是对页面任何动画都重新判断，但关键漂移必须重新观察。
- 超过候选限制时先筛选作用域、分组再选择；保留 `none`/`no_match`，不得截断后假装目标必定存在。
- TypeSafe Choice 单题最多 255 项，建议单层候选不超过 200（含 no-match），为协议变化留余量。[S8]
- 不缓存跨导航的 DOM handle 或 Jev 判断。已验证的流程可以复用，但重新验证定位器与前置条件。
- 页面脚本为内置观察实现，不向调用方暴露任意 evaluate；仅在选定页且 origin 获授权的 frame 安装 observer，导航后复核权限再重装、断开后尽力清理。iframe 单独校验 origin，未授权的跨域 frame 不读正文；闭合 Shadow DOM 或不可访问 frame 明确不支持，不宣称观察脚本完全没有注入副作用。

### 6.3 判断组合

同一份 state 上可并行问独立问题，如 `done`、`blocked`、`error`、动作候选、目标候选、value key。问题若有条件前提，必须在 instructions 中显式写出；返回后只消费相关分支。[S9]

跨参数的组合不因类型正确就自动正确：例如 action=upload 但 target 不是 file input，代码应拒绝。需要依据前一个回答生成的新候选，分成下一次请求，不能把依赖问题伪装成并行。

每轮判断到任务状态的映射固定不变：`done` 仅在证据充分时生效；`error` 映射 failed 并附脱敏证据；`blocked`（验证码、拒绝访问）映射 `paused/needs_input`，由人工处理后恢复或取消，不自动重试；其他不确定结果一律映射对应 pauseReason，不新造状态。

- 输入文本来自调用者 values、程序提取或规划器在用户许可下生成；Jev 只选 key，不生成密码、自由文本或文件路径。
- 敏感值只通过预先配置的 secret alias 或调用者临时安全输入提供；值仅保留在进程内存，模型只见用途/类型。alias 绑定主体、origin、字段用途；任意 `secretRef` 不能用来枚举环境变量或读取服务 key。首版不自动把 secret 写入数据库，重启后缺值则 `paused/needs_input`。
- Choice 的 confidence 和 Noul 的 yes 概率分开存储；它们不是业务成功率、也不是执行授权。[S10]
- 失败返回 top candidates、脱敏证据、状态和分项概率；不伪造 Jev 的自然语言解释。
- 数值阈值必须经过业务数据校准。上游阈值只作实验候选，不直接当成通用可靠规则。

### 6.4 等待、重试与预算

- 用 locator 自动等待、导航/下载/响应等明确事件、目标区域稳定性与断言等待；不固定每步 sleep，不默认等待全页 networkidle。[S11]
- SPA 长连接不阻塞任务；等待有上限。异常时可短暂扩展观察，但不无限刷新。
- Jev/规划 API 的网络重试受总任务 deadline 管理；避免 SDK 重试 × 外层重试相乘。401/配置错误快速失败，429/临时故障按 SDK策略及剩余预算处理。[S8、S7]
- click/submit/付款等动作超时不意味着没执行。先核实后置状态；无法确认则 `paused/needs_input`，不盲目重放。`Promise.race` 结束等待不等于取消 Playwright 操作：动作未真正 settle 时保持 profile 占用并隔离，拒绝下一任务写入。无法确定停稳则先把任务转 `paused/interrupted`，再按 detachTask 流程断开连接并标记人工复核，不能关闭用户浏览器来“取消”。
- 维护最大动作、步骤、Jev/规划请求数、重规划次数、token 和执行时长预算；动作尚未派发时耗尽返回 `status=failed, error.code=BUDGET_EXCEEDED`。如果预算在动作进行中耗尽，先进入 `cancelling`，等待动作 settle 或隔离；结果不明时使用 `ACTION_OUTCOME_UNKNOWN`，不能用普通预算失败覆盖未知副作用。请求数包含重试；token 按两类服务的实际 usage 累计，发送前以剩余额度和上下文上限预检，不能宣称这是精确的计费硬上限。usage 缺失或失败请求可能计费时明确记录未知，不当作零。
- `runtime.timeoutMs` 限制任务的累计自动执行时间，包含连接、模型、页面等待和重试；独立 session/connect 的耗时记在 session，one-shot CLI 首次连接则归入该任务。跨入口比较计时必须把必需的 session 建立也算入。queueTimeoutMs 与 pauseTtlMs 分别是累计排队/累计人工暂停额度，重复 resume 不重置；到期变 expired。默认另设任务受理后 30 分钟的绝对有效期，调用者只可缩短；执行额度先耗尽仍用 BUDGET_EXCEEDED。
- 循环检测结合页面指纹与动作序列，不把合法滚动简单视为循环。

## 7. 可选规划器（B）

定义 `PlannerProvider.plan/replan`，输入为用户目标、允许域、值引用、工具 schema、脱敏观察和已完成步骤；输出为严格校验的 `FlowStep[]`，不是可执行 JS/Python。

- 第一版仅实现一个明确配置的文本模型 Provider；厂商和模型由使用者配置，P4 编码前核对该服务真实协议。不要宣称所有“兼容 API”都支持同一结构化输出。
- 在任务开始生成有限短计划；成功步骤间不反复调用大模型。新页面出现未预期分支时才按需重规划。
- 每个步骤带完成条件；无法确定输入、金额、账号、收件人等信息时输出 `needs_input`，不猜测。
- 若要生成表单正文，保留来源和用户意图约束；秘密只通过引用传递。
- 重规划只修改未完成后缀，保留已完成动作和副作用记录；不得重新执行已付款/已发送步骤。
- schema 校验失败最多一次受预算控制的修正请求，仍失败则明确报错。
- 规划器不可放宽安全策略、域权限、confirmation 或预算；网页中“忽略规则”的内容仅视为数据。
- `execute` 引擎不依赖 planner 的初始化；即使没有规划 key，也能运行已有流程。

## 8. 统一契约（拟议 v1）

### 8.1 输入与步骤

session 创建接受 `schemaVersion, target, allowedOrigins, modelOrigins`：target 为 `{kind:"existing", pageId?}` 或 `{kind:"new", url}`，origin 列表必须是宿主预先许可集合的子集。origin 默认为空，不默认允许全部网站；modelOrigins 是 allowedOrigins 的子集，单独控制云模型外发。CLI 用户可在可信启动配置中授权，不由网页或模型批准新域。仅列出已授权域的脱敏页面元数据；无唯一匹配页则 session 保持 `awaiting_page`，不开始任务。session 状态为 `awaiting_page | ready | disconnected`，与任务状态分开。

`execute` 接收 `schemaVersion/sessionId/steps/values?/budget?/deadlineAt?`；单目标也是一项 kind=goal 的 step。`run` 接收 `schemaVersion/sessionId/goal/successCriteria/values?/budget?/deadlineAt?`。values 为 JSON 值或有范围限制的 secretRef，不做任意 `${...}` 插值。session 绑定主体和浏览器，任务不能扩大权限；没有有效 ready session 的协议请求在排队前拒绝。

successCriteria 定义用户可观察的任务级结果，例如集合范围、截止条件、最大项数、允许跳过/失败策略；缺失时 CLI 可交互补充，非交互返回缺字段错误，不能由规划模型单方面发明通过标准。模型只能把它细化为步骤期望，不可削弱；步骤全成功但总目标未验证时不报 done。独立的总验收逻辑防止规划器以空计划或较容易的目标“自证完成”。

successCriteria 的验证方式按形式区分：结构化条件由代码确定性判定；自然语言条件由 Jev 语义验证并附脱敏证据，证据不足则 `paused/needs_input` 转人工确认。两种形式都不得仅凭规划模型声称“目标达成”就判 done，goalVerification 必须记录验证主体与证据类型。

FlowStep 为带 kind 的联合类型：

- `action`：动作枚举、LocatorSpec、values 引用、expect。导航、写操作与下载必须提供后置条件；纯观察操作可由返回证据验证。底层 `act` 也受此约束，Playwright 调用未抛错不等于业务目标完成。
- `goal`：一个明确 goal、values 候选和必须提供的结果 expect；允许语义验证，但标注证据类型。
- `assert`：URL/文本/可见性/数值/计数/下载等允许的断言。
- `extract`：指定作用域和返回字段，不含任意脚本。
- `branch`：只能依赖已经验证的变量和白名单比较算子；不执行字符串代码，首版不允许任意嵌套分支。
- `forEach`：遍历有界集合，显式 maxItems；每次实际进入的迭代/子步骤都计入全局 maxSteps/maxActions，不仅计算计划数组长度。跨导航只存稳定业务 ID/URL 等数据，每轮重新定位，不保存 elementId 或 DOM handle；支持逐项终态记录，未处理项不能计为成功。分页需定义停止条件和总项数上限。

LocatorSpec 优先 role + accessible name、label、testId；CSS 是显式备用。模型不生成任意 XPath/JS。唯一性不成立时停下澄清。

流程契约示意（示例页面，不是你的业务站点）：

```json
{
  "schemaVersion": 1,
  "sessionId": "session-from-create",
  "steps": [
    {
      "id": "read-heading",
      "kind": "extract",
      "target": { "by": "role", "role": "heading", "name": "Example Domain", "exact": true },
      "fields": ["text"],
      "saveAs": "heading"
    },
    {
      "id": "verify-heading",
      "kind": "assert",
      "expect": { "variable": "heading.text", "operator": "equals", "value": "Example Domain" }
    }
  ]
}
```

### 8.2 结果和状态

统一 envelope：`schemaVersion, taskId, sessionId, mode, revision, status, pauseReason?, stepResults, goalVerification, evidence, metrics, error?, pendingApproval?, artifacts?`。error 至少含 `code/message/retryable/details`（脱敏）；`retryable` 指请求层能否重试，不代表允许重放网页动作。只读操作的返回可使用独立 schema，不伪造 taskId。

状态与原因分离，不再把 likely_done、超时、失败、人工确认都塞进一个 status 枚举：

```text
queued → running → done | failed
             └→ paused → queued（显式恢复）
queued / paused → expired（无在途动作）
queued / running / paused → cancelling → cancelled（显式取消）
running → cancelling → expired（绝对 deadline 到期）
running → cancelling → failed（执行预算耗尽）
pauseReason = likely_done | ambiguous | needs_input | needs_login | needs_confirmation | interrupted
```

- done/failed/cancelled/expired 为终态，不能 resume。paused 才可恢复，剩余预算和 taskId 不变；先原子取得已有 profile 预约的执行权，再重新连接/选页和核验，不能在加锁前操作页面。核验失败退回 paused；成功后继续未完成部分。cancelling 记录 stopReason 与目标终态，待动作 settle 或隔离后再提交终态。结果未知时在 error/evidence 中标记 ACTION_OUTCOME_UNKNOWN，profile 隔离记录独立于任务终态保留，人工对账前不接新写任务。
- `done` 同时要求必要步骤与总目标验收通过，goalVerification 明确 deterministic/semantic/human 证据；`paused + likely_done` 不计成功。对要求全部处理的任务，有失败/未知/未访问项不能报 done；用户预先允许部分成功时返回显式逐项汇总，不隐藏失败。
- paused 预约整个 browser profile，而不是仅标签页（登录态/购物车等共享）；同 profile 的其他任务不执行。只允许该任务的受控只读核实、批准、取消；排队超过额度则过期。用户可取消后让出 profile，不能以“暂停”换取无保护的并行。
- cancel/resume/approve 都带 requestId 与 expectedRevision；先以主体+taskId+requestId 查重，同请求返回原结果，不同参数报冲突，首次请求才校验 revision。状态改变使用事务，不因客户端重试重复取消/批准。approve 先校验并暂存 grant，不执行动作；resume 取得 profile 执行权、重验实际动作后，在动作派发前原子消费 grant 并提交 prepared。grant 绑定待批准 actionRevision，而非会被轮询/暂停变更的普通 task revision；动作改变、参数或关键页面变化即失效。
- 重启后遗留 queued/running/paused 不自动跑起来：转 paused/interrupted（超过 deadline 则 expired），重新连接/选页/补秘密并核验。遗留 cancelling 按原 stopReason 收尾；unknown 动作保留隔离，不能因 TTL 到期或重启丢掉复核要求。暂停/断开不删除原 pendingAction、审批需求和证据。终态也不代表撤销了外部副作用。

### 8.3 各适配器

| 能力 | MCP 工具名（拟议） | CLI 子命令 | HTTP 路由（拟议） |
| --- | --- | --- | --- |
| 诊断 | `browser_doctor` | `doctor` | `GET /v1/diagnostics` |
| 创建/绑定 session | `browser_connect` | `connect`（长驻模式） | `POST /v1/sessions` |
| 页面列表/选择 | `browser_pages` / `browser_select_page` | `pages` / `select-page` | `GET /v1/sessions/:id/pages` / `POST .../page` |
| 明确步骤 | `browser_execute` | `execute` | `POST /v1/tasks/execute` |
| 完整目标 | `browser_run` | `run` | `POST /v1/tasks/run` |
| 观察/单步 | `browser_snapshot` / `browser_act` | `snapshot` / `act` | `POST /v1/sessions/:id/snapshot` / `.../act` |
| 查询 | `browser_task_get` | `task get` | `GET /v1/tasks/:id` |
| 取消/恢复/确认 | `browser_task_cancel`、`browser_task_resume`、`browser_task_approve` | `task cancel/resume/approve` | `POST /v1/tasks/:id/cancel` / `resume` / `approve` |
| 下载结果 | `browser_artifact_get` | `artifact get` | `GET /v1/tasks/:id/artifacts/:artifactId` |
| 断开 | `browser_disconnect` | `disconnect` | `DELETE /v1/sessions/:id` |

- HTTP 创建任务返回 202 + taskId，不把“已接收”当完成；用 GET 轮询或已认证的事件流查询。配置/输入错误不排队。
- MCP 快任务返回结果；长任务返回同一 taskId，由查询工具继续，避免依赖所有客户端支持同一种长任务扩展。
- CLI 默认运行到终态或暂停；`--json` 禁止交互，仅输出 envelope，进度写 stderr。拟定退出码：0 done，2 参数/配置错误，3 paused，4 failed/expired，130 cancelled；查询类命令退出码 0 表示查询成功，不表示被查任务完成。策略阻止、能力不足、预算耗尽使用 failed + 明确 error.code。
- 单次 CLI 可用显式 `--page` 或 `--url` 和可信域配置创建 session；交互模式无唯一页面时提示选择，非交互返回错误，不猜标签页。常规任务结束才 disconnect；遇 paused，在同进程交互等待，或保存 checkpoint、保留任务级 profile 预约后断开连接并退出码 3。之后 `task resume --task-id ...` 重建 session、映射新 pageId 并复核；无需旧内存对象存活。不自动保活 launch 进程，关闭后若临时页面状态无法重建就需要用户处理。频繁多命令/跨入口使用长驻服务。
- act 通过 TaskService 执行单步任务，沿用同样的锁、预算、审批、revision、deadline 和后置条件，不能绕开已暂停/运行任务。snapshot 等观察在同 profile 有活动任务时也经调度，不能窃读另一个任务的页面。HTTP 客户端断开不等于取消，直到收到取消请求或 deadline；MCP 宿主退出走统一中断收尾，不能遗留继续执行的无主任务。
- HTTP 幂等记录以 `endpoint + Idempotency-Key` 为索引，保存规范化请求体摘要与原 taskId（拟保留 24 小时）。同键同摘要返回原任务；同键不同摘要返回 409，不另建任务。请求体摘要不放进索引，否则无法识别同键不同输入。记录持久化与任务创建须原子提交；过期后不承诺去重。它只防重复任务提交，不宣称外部网站动作具备 exactly-once 语义。

## 9. 会话复用、并发与效率

### 9.1 存储与恢复的最小实现

- TaskStore 使用本地事务存储（优先 SQLite，驱动在 P1 按 Windows/Node 安装兼容性选定），保存 schemaVersion、revision、状态、预算、逐项进度、请求幂等摘要和动作账本。不能只靠内存 Map 却声称重启去重；也不使用多个独立 JSON 文件模拟跨记录原子提交。存储适配器通过崩溃注入测试后才允许持久任务。
- 每个动作在派发前先提交 `prepared`，随后在调用 Playwright 前提交 `in_flight`，结果记录 `verified/failed/unknown`。数据库提交与外部网站动作无法构成同一事务，因此重启遇 in_flight/prepared 都先对账，不宣传 exactly-once。
- 一个 dataDir 由一个宿主进程持锁使用；第二宿主要通过该 API 访问或报冲突。不同 dataDir 仍使用同一平台用户级 profile 锁目录，防止独立 MCP/CLI 争用相同浏览器。
- 业务原文/截图/提取数据默认只在内存或受限 artifact 中；checkpoint 只持久化明确允许保存的最小步骤和变量引用，不保存密码/secret 值。缺失目标或变量时要求用户重供、核对摘要，不能保证任意敏感任务都能透明恢复。
- 状态/幂等元数据拟保留 24 小时、临时 artifact 拟保留 24 小时；只清理工具所有文件，用户显式导出的文件和 profile 不自动清理。终态写入后再计 retention，active/paused 记录由 deadline 管理。目录限制当前用户访问，不把“脱敏”称为全数据加密。

### 9.2 进程模式

- **嵌入模式**：CLI 单次进程、MCP 长驻进程各自嵌入同一 core。
- **共享模式**：`api` 适配器作为本地长驻宿主，CLI/MCP 经显式配置转发标准契约；一次 CDP 连接服务多个授权请求。不自动启动隐形 daemon，不额外复制业务。
- 默认每个日常 profile 同时一个任务，宁可排队不竞争；跨独立 launch profile 才开放并行。
- 对本工具的跨进程访问增加平台用户级 profile 锁：统一规范化 profile 路径/浏览器实例标识，localhost/127.0.0.1/不同 dataDir 不得形成重复控制器。维护 owner PID、进程启动标记和 generation；每轮执行前检查所有权。心跳过期不能直接抢锁，先确认原进程已退出；未确认则 BROWSER_BUSY。跨重启的任务预约独立持久化，恢复也不能绕过未知在途动作。不能据此宣称锁住人工或其他软件。
- 人工干预通过状态漂移检测暂停；只有只读且无共享副作用的独立页任务，在专项测试后放开并发。

### 9.3 性能策略与禁忌

1. 复用浏览器/CDP/模型 HTTP 客户端，不每步 launch 或重连。
2. 多步骤一次提交，内部逐步验证；不在成功路径每次回到规划者。
3. 同状态独立问题合并；候选压缩只减冗余，不漏关键上下文。[S9]
4. 局部观察、差量和按需截图；默认无 slowMo、无动作高亮、无常驻视频/全量 trace。
5. 缓存已验证流程与 schema，不缓存跨页面的动作判断；复用必须校验页面/业务版本。
6. 顺序预算贯穿连接、等待、API retry 和执行；减少排队和重复工作的指标单独记录。
7. 不使用 `force: true`、忽略验证、跳过授权或自动点击验证码作为提速策略。

端到端时间 = 排队 + 连接/授权 +（外部或内部）规划 + 页面观察 + Jev + Playwright/站点响应 + 验证 + 重试/恢复。

A/B 比较要同时报告含人工等待和不含人工等待两种耗时；A 的外部 Agent 时间不可漏算。确定性流程单独比较执行开销，不把它和需要语义规划的复杂任务混成一个平均值。

## 10. 安全、隐私和副作用

- **页面是数据，不是指令**：站点文字不能覆盖工具规则、修改目标、扩展允许域、读取本地文件、替换模型端点或执行 shell。
- **借用 profile 的信任边界**：CDP 技术权限很广，应用层仅访问授权目标不等于浏览器级隔离；不得向不信任客户端暴露接管服务。工具发起导航前检查目标，页面/弹窗改变 origin 后立即停止后续观察、操作和模型外发，SSO 等必要新域需先授权。该检查不保证阻止网页自己发出的跨域网络请求；需要网络级隔离的任务使用独立实例和专门网络策略，不能把 origin allowlist 当防火墙。[S3]
- **副作用统一拦截**：A、B、底层 act 都走同一 PolicyGate。发送、购买、付款、删除、账号/权限改变默认必须确认；风险不清楚时暂停。
- **不能仅靠 Jev 风险概率授权**：结合动作类型、目标域、参数和业务规则；未知站点不能保证自动推断所有隐藏副作用。无法可靠限定的写操作要求人工确认。
- **确认绑定具体动作**：grant 绑定 taskId、stepId、actionRevision、账号、origin、目标、参数哈希、相关页面指纹和有效期；一次性消费。会影响动作语义的状态变化即失效，不把无关时钟/动画变化当作审批失效；消费与 prepared 记录原子提交。禁止全局 `allow_irreversible=true`。
- **权限与意愿分离**：执行 token 不拥有审批权限；Agent 不能凭 `approved: true`、调用 approve 或复述用户话语签发授权。approve 只消费签名 grant；签发依赖独立管理凭据/可信用户确认器，凭据不注入执行 Agent。给同一 OS 用户运行的 Agent 一个可自行调用的“确认 CLI”不构成隔离边界；签发命令也必须有独立认证/用户在场校验，缺少时只允许受限预授权动作，其他保持暂停。本工具不防御已可读审批密钥的本机恶意进程。
- **真实页面外发**：Jev 和规划模型仅接收 modelOrigins 允许的页面片段；字段最小化、secret 屏蔽、URL query/fragment 裁剪同时作用于请求、错误和日志。通用脱敏不能可靠识别所有商业秘密，敏感域默认禁云模型，拒绝时要求确定性操作或人工处理；不得承诺“脱敏后绝不泄露”。整页截图可能包含秘密，不默认发送模型；若无法可靠遮罩则拒绝外发。
- **HTTP 服务**：默认仅 loopback、强制随机 token（由用户环境提供）、校验 Host/Origin、不启用宽松 CORS、不在 URL 放 token、限定请求体/速率/并发；远程访问需要另行认证/TLS设计。
- **任务级访问控制**：session、task、下载 artifact 的操作边界由会话归属与任务状态机保证（如预约期间防窃读、跨会话不可见页面明细）；调用方身份不做区分（单用户本机工具，`--api` 模式以 Bearer token 为边界）。错误里不泄露其他任务的信息。工具不提供不受约束的网络请求或远程路径入口。
- **文件**：上传须同时授权具体本地文件和目的 origin，不因根目录许可就准许把所有文件传给任意网站。规范化真实路径并阻止 traversal/symlink 绕过，秘密文件默认拒绝；运行时复核实际文件。下载存到任务专属目录，清理文件名/扩展名和覆盖策略，不自动打开/执行。大小限制在已知长度时预检、下载中尽力中断、结束后复核；attach 保留浏览器默认下载时不能保证网络/磁盘硬上限，硬配额需求应拒绝该模式。
- **下载正确性**：先注册 download 事件再触发动作，完成后验证并 `saveAs` 到受管 artifact 区，再返回 artifactId/文件名/大小/摘要；不能仅返回将在关闭 context 时删除的临时路径。[S13] API 返回可鉴权下载的 artifactId，不向远程调用者暴露宿主绝对路径；请求路径不允许任意文件。attach 若无法取可靠事件/文件关联，返回 failed/UNSUPPORTED_CAPABILITY 或 paused/needs_input，不全盘扫描日常下载目录、不修改全 context 默认设置、不把点击认作下载完成。
- **日志**：只记任务、耗时、状态、概率和脱敏证据；默认不记录正文、截图、Cookie、密码、请求 header。显式 debug 也要经过脱敏和 retention 限制。
- **取消/退出**：停止后续动作并尽力中断模型/等待；已提交外部动作无法保证撤销。取消请求先进入 `cancelling`，在途动作未 settle 前保留 profile 锁，结果未知时不能自动重试；安全状态检查后断开，不关日常 Chrome。

## 11. 可观测性与验收关联

统一记录 task/step/round 关联 ID，queue/connect/observe/jev/planner/action/verify/retry 时间，模型实际版本，token，用量估计（无价格表时不编造金额），动作数、重规划数和成功证据。

能力探测结果至少包括 attach、page observation、frame access、upload/download、dialog、screenshot、detach-preserves-browser、artifact-save-after-disconnect、profile-lock、sandbox；未知能力不标为 supported。

验收矩阵、任务集、失败预算和阶段门槛详见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。不能把上游几十个任务的成绩或本文的设计信心当成本工具的成功率或性能承诺。
