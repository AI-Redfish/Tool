# 技术原理

浏览器控制工具（Playwright + Jev）。

> `core + cli + mcp + api` 四包工作区；确定性步骤（execute）与自主目标（run）共用同一执行引擎。版本 `0.1.0`。



## 总体分层

**一个核心，三个适配器**

```text
CLI（node cli/dist/index.js）   MCP（stdio, 14 工具）   HTTP API（loopback+token）
      └──────────────── 同一套 Runtime（core）────────────────┘
                              │
   ┌──────────────┬───────────┴──────────┬──────────────┐
   │ 连接层        │ 持久化/状态层         │ 执行层        │
   │ connectors   │ store+statemachine   │ FlowExecutor │
   │ (attach/     │ +taskservice(Runtime)│ GoalExecutor │
   │  launch)     │ SQLite 单库事务        │ Planner      │
   └──────────────┴──────────────────────┴──────────────┘
```

CLI、MCP、HTTP API 只是三种协议翻译层，行为与输出契约（TaskEnvelope）完全一致。



## 两种入口模式与三个执行器

**入口模式**

execute和run，外部工具如CLI的命令入口。

如CLI有execute和run两种子命令。



**执行器**

core 里的三个类，内部组件。

| 执行器 | 是什么 | 模型调用 | 什么时候被用到 |
|---|---|---|---|
| `FlowExecutor` | 确定性步骤执行引擎（action/assert/extract/branch/forEach） | 0 次 | **execute 和 run 共用**——所有步骤最终都由它执行 |
| `GoalExecutor` | `kind:"goal"` 步骤的处理器：Jev 局部语义循环（观察→Jev 判断→执行一个动作→差量再观察） | 每轮调 Jev | **既不专属 execute 也不专属 run**：FlowExecutor 执行中遇到 `goal` 步骤就转入它（两入口的步骤里都可含 goal） |
| `Planner` | 计划生成器：把 goal+successCriteria 拆成 FlowStep[] | 每次规划 1 次 | **仅 run 入口**在开工前调用一次；产出的计划仍交回 FlowExecutor 执行 |



**run任务两层验收**

 ```
   run 任务的时间线：

   Planner 产计划 → FlowExecutor 逐步执行
                       │
                       ├─ 遇到 goal 步骤 → GoalExecutor 循环
                       │     └【第 1 层：步骤级验证】
                       │       judge.decideRound() 判断"这一步做完了吗"
                       │       → 返回 verification → 该步骤标 done → 继续下一步
                       │
                       ▼
                 所有步骤都 done 了
                       │
                       ├【第 2 层：任务级验收】← 误解高发区
                       │   Runtime 自己调 judge.check(
                       │     `任务级验收：${successCriteria}`)
                       │   p ≥ doneAt → 任务落 done
                       │   p < doneAt → 暂停 likely_done（步骤全成功也没用！）
                       ▼
                    任务结束
 ```



## 变量体系（values 与 vars 是两个命名空间）

| 命名空间 | 来源 | 内容 | 谁能读 |
|---|---|---|---|
| `values` | `--values` / API 请求体传入，启动时经 `resolveValues` 解析（secretRef → 环境变量值） | 标量（string/number/boolean/null） | 步骤的 `valuesRef` **优先**读这里 |
| `vars` | 运行中产生：`extract.saveAs` 存入 `{text?,count?}` 对象；下载成功写 `lastArtifact`（artifactId）；forEach 写 `itemVar` 与 `<itemsVar>.processed/.total` | 对象/标量 | `valuesRef` 查不到 values 时回退读这里；`assert` 的 `var_equals`/`branch` 的 `variable` 也读这里 |

引用一律用**点号路径**（如 `heading.text`）；没有 `${name}` 模板插值（那是 jev-desktop 的语法）。

### 连接层：先分清浏览器是谁的

- `attach`（借用，默认）：`connectOverCDP('chrome')` 哨兵走 Playwright 固定版本 channel 发现，失败回退读默认用户目录 `DevToolsActivePort`；`noDefaults:true` 保证绝不 newContext 冒充用户会话、绝不关用户浏览器，`close()` 仅断开 CDP；显式端点只收 loopback（防页面/模型注入远程地址）。需 Chrome ≥ 144 在 `chrome://inspect/#remote-debugging` 人工授权（实操教程见使用步骤 3）。
- `launch`（自有）：`launchPersistentContext` + 按 engine 独立 profile 目录，可安全关闭；报错区分「未安装」与「profile 被占」。无头仅适用于 launch。
- 其余层只依赖 `ports.ts` 结构接口，Playwright 类型被隔离在 connectors 一个文件。

由此决定的使用约束：launch 模式下浏览器实例属于启动它的进程——裸 CLI 跨命令复用会话不可行（进程退出浏览器即关），跨命令长会话必须用长驻 API 或 attach。

### 状态层：SQLite 单库事务

tasks / 会话 / 动作账本 / 幂等记录 / 审批 grant / artifact / 预约锁同库原子提交：

- **任务状态机**（显式转移表）：`queued → running → done|failed|expired|cancelled`，取消经 `cancelling`；暂停态 `paused`（原因：`likely_done/ambiguous/needs_input/needs_login/needs_confirmation/interrupted`）。崩溃恢复只落 `paused(interrupted)`/`expired`，绝不自动回 running。
- **动作账本**：每个动作 `prepared→in_flight→verified/failed/unknown`；非幂等动作超时先查证、不确定即隔离（该 profile 新写任务拒绝、只读放行，`rerunConfirmed` 解除）。
- **幂等**：`Idempotency-Key` 同键同体重放返回原任务、异体冲突报 `IDEMPOTENCY_CONFLICT`（24h 保留）。
- **乐观锁**：cancel/resume 可带 `expectedRevision`，并发修改报 `REVISION_CONFLICT`。

### 安全模型

1. **双层 origin**：`allowedOrigins`（会话可碰域）∪ `modelOrigins`（可把页面摘要外发云模型的域，必须 ⊆ 前者）。**默认两者皆空 = 不许可任何网站、禁止任何云外发**；域外导航/动作报 `ORIGIN_NOT_ALLOWED`，外发时报 needs_input 暂停。API/MCP 任务只能从宿主已许可域中选子集，不能自行扩大。
2. **PolicyGate**：每动作派发前综合判定（动作类型+目标名+域）；命中风险 pattern（支付/删除/发送/pay…）一律 `paused + needs_confirmation`，**不执行**。
3. **审批 grant**：解锁靠 HMAC 签发的一次性 token——短 TTL、绑定 actionRevision（动作被改即失效）；签发 key（`JEV_BROWSER_APPROVAL_KEY`）是执行 Agent 不持有的凭据，不同源才构成审批边界。
4. **secretRef**：敏感值 `{"secretRef":"NAME"}` 从 `JEV_BROWSER_SECRET_<NAME>` 环境变量内存解析，不落盘、不进模型请求体/日志。
5. **其余边界**：下载先注册等待再触发点击（消除竞态）→ saveAs 受管 artifact 区；对话框默认保守 dismiss，仅显式 `armOnce` 的预期 confirm 才接受且一次性；观察脚本内置固定白名单，不执行模型生成的 JS；upload 只允许 `safety.allowedUploadDirs` 内文件（realpath 防穿越）。

### 错误与输出模型

- 所有错误带 `code/message/retryable` 三要素；错误码全集见 `core/src/types.ts`。
- 统一输出 TaskEnvelope（字段见使用步骤 2.2）；`--json` 输出完整 envelope，人读摘要在 stderr。
- Jev 判断只做闭集判断（Choice 选候选 / Noul 是否判断），不生成自由文本；候选超 200 先按关键词筛选；阈值映射（done≥0.85、blocked/error≥0.7、中间带需二次确认），歧义即暂停不猜。

---

## 使用步骤

### 步骤 0：前置条件与构建

| 项 | 要求 | 说明 |
|---|---|---|
| Node | ≥ 24 | 任务库用 `node:sqlite`（24 起内置），低版本启动即报错 |
| 浏览器 | 二选一 | launch：Playwright 管理的 Chromium（可自动装）；attach：本机 Chrome ≥ 144 + 人工授权（见步骤 3） |

```powershell
cd tools/jev-browser
npm install && npm run build
node cli/dist/index.js help        # 打印命令帮助 → 构建成功
npm test                           # 62 个离线测试，无需浏览器/key
```

Chromium 运行时（launch 模式首次需要，约 115MB，国内可加镜像）：

```powershell
$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://cdn.npmmirror.com/binaries/playwright"
npx playwright install chromium
```

**doctor 自检与输出逐行解读**：

```powershell
node cli/dist/index.js doctor
```

```text
配置文件: C:\Users\you\AppData\Local\AI-Redfish\jev-browser\config.json（或 "(未使用，默认值)"）
环境变量覆盖: JEV_BROWSER_MODE, JEV_BROWSER_ENGINE          ← 本次生效的 env 覆盖列表（没有则省略）
[OK] node: node 24.12.0（本工具需要 ≥ 24：node:sqlite）      ← 版本检查
[OK] dataDir: C:\Users\you\AppData\Local\AI-Redfish\jev-browser ← 数据目录可写（不可写会 [FAIL]）
[OK] launchProfile: ...profiles\chromium\default             ← launch profile 目录状态
[OK] chromiumInstall: 未自动检查；显式执行 npx playwright install chromium ← 提示性，非失败
[OK] credentials: jev(TYPESAFE_API_KEY)=未配置（纯确定性 execute 不需要）; planner=未配置（run 需要）; api token=未配置（启动 API 需要）
[capability] attach-chrome-cdp: unverified — ...             ← 能力表：未实测项标 unverified，不冒充 supported
```

要点：`credentials` 行的「未配置」是**正常**的——纯确定性 execute 不需要任何 key；只有 `run`（要 planner）和 `goal` 步骤（要 Jev）才需要。加 `--connect` 会多一行 `[connect] OK/FAIL: ...`（尝试接管 Chrome，见步骤 3）。

工作区 npm scripts：`build` / `clean` / `test` / `smoke`（端到端冒烟，输出 `"result": "go"` 即就绪）/ `start:mcp` / `start:cli` / `start:api`。

### 步骤 1：配置与数据目录

优先级：CLI 参数 > 环境变量（`JEV_BROWSER_*`）> JSON 配置文件 > 默认值；严格合并，未知字段/类型错直接拒绝。

```jsonc
// 默认（接管日常 Chrome）；完整字段见 DESIGN §5.2，可复制示例在 examples/
{
  "schemaVersion": 1,
  "browser": { "mode": "attach", "engine": "chrome", "headless": false,
               "attach": { "endpoint": "chrome", "noDefaults": true } },
  "planner": { "enabled": false }
}
// 切换为工具管理的无头 Chromium：
{ "schemaVersion": 1, "browser": { "mode": "launch", "engine": "chromium", "headless": true } }
```

```powershell
# 环境变量等价覆盖（未激活的 attach 子对象保留但不使用；不会隐式把 attach 变 launch）
$env:JEV_BROWSER_MODE = "launch"; $env:JEV_BROWSER_ENGINE = "chromium"; $env:JEV_BROWSER_HEADLESS = "true"
```

| 项 | 位置 |
|---|---|
| 配置文件默认位置 | `%LOCALAPPDATA%\AI-Redfish\jev-browser\config.json`（`--config` 指定） |
| 高频环境变量 | `JEV_BROWSER_MODE/ENGINE/HEADLESS`、`JEV_BROWSER_CDP_ENDPOINT`、`JEV_BROWSER_CONNECT_TIMEOUT_MS`、`JEV_BROWSER_DATA_DIR`、`JEV_BROWSER_API_TOKEN`、`JEV_BROWSER_APPROVAL_KEY`、`JEV_BROWSER_SECRET_<NAME>` |

**数据目录结构**（默认 `%LOCALAPPDATA%\AI-Redfish\jev-browser\`，`JEV_BROWSER_DATA_DIR` 可改）：

```text
jev-browser\
├── tasks.db                    # SQLite 单库：任务/会话/动作账本/幂等记录/审批 grant/artifact 元数据
├── config.json                 # （可选）用户配置
├── artifacts\<taskId>\         # 每个任务一个目录：截图/下载文件（文件名 = <artifactId>-<原文件名>）
└── profiles\<engine>\default\  # launch 模式的浏览器 profile（chrome / chromium 各自独立，互不混用）
```

- `tasks.db` 可安全删除（会丢历史任务/账本/幂等记录，正在运行的任务会失联）；`artifacts\` 按任务目录删，不影响库外数据；`profiles\` 删除后下次 launch 重建（登录态等会丢）。
- artifact 的权威信息在 `tasks.db`（artifactId ↔ 文件名 ↔ 大小），手动挪文件会与库不一致——清理请按任务整体删。

### 步骤 2：CLI 使用

入口：`node cli/dist/index.js <命令>`（下称 `cli`）。

**全局参数**（所有命令可用）：

| 参数 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `--config <path>` | string | — | 配置文件路径 |
| `--json` | 旗标 | 关 | stdout 输出完整 envelope JSON |
| `--api <url>` | string | — | API 转发模式：转发到长驻 API（token 取 `JEV_BROWSER_API_TOKEN`） |
| `--principal <name>` | string | `local` | 调用者身份标识 |
| `-h` / `--help` | 旗标 | — | 帮助（退出码 0） |

JSON 参数（`--file`/`--steps`/`--values`/`--step`）三种等价写法：内联 JSON、已存在的文件路径、`-`（stdin）。

#### 2.1 第一条命令与 flow 逐字段精讲

```powershell
cli execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```

`examples/read-page.flow.json` 全文与逐字段讲解：

```jsonc
{
  "schemaVersion": 1,          // 契约版本（当前 1）
  "steps": [
    {
      "id": "goto",            // 步骤 id：账本/envelope/断言失败信息都引用它，必填且同 flow 内唯一
      "kind": "action",        // 六种步骤之一（见 2.6 契约速查）
      "action": "navigate",    // 动作名：navigate/click/fill/press/select/scroll/wait/screenshot/upload
      "value": "https://example.com",   // 字面值；若写 "valuesRef":"xxx" 则从 values/vars 取（优先级更高）
      "expect": [              // 后置条件：导航/写操作/下载【必须】提供，纯只读动作可省
        { "kind": "url_contains", "value": "example.com" }   // 断言当前 URL 包含该串
      ]
    },
    {
      "id": "read-heading",
      "kind": "extract",       // 提取步骤：读页面数据存入流程变量
      "target": {              // LocatorSpec 白名单定位（模型不得生成任意 XPath/JS）
        "by": "role", "role": "heading", "name": "Example Domain", "exact": true
      },
      "fields": ["text", "count"],   // 要提取的字段：text=首个匹配的innerText；count=匹配元素数
      "saveAs": "heading"      // 存入 vars["heading"] = { text, count } → 后续用点号引用 "heading.text"
    },
    {
      "id": "verify-heading",
      "kind": "assert",        // 纯断言步骤（不动页面）
      "expect": [
        { "kind": "var_equals", "variable": "heading.text", "value": "Example Domain" }
        // var_equals/var_contains/var_exists 引用变量用 variable 字段（点号路径）
      ]
    },
    { "id": "shot", "kind": "action", "action": "screenshot" }   // 截图存 artifact（只读动作可不带 expect）
  ],
  "values": {}                 // flow 文件内也可带 values（命令行 --values 会与之合并使用）
}
```

`execute` 参数全表：

| 参数 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `--file <path>` / `--steps <json>` | string | 二选一 | FlowStep 数组（文件也接受完整 flow 对象 `{schemaVersion, steps}`，自动拆包） |
| `--url <url>` / `--page <id>` / `--session <id>` | string | 三选一 | 新开页 / 绑定既有页 / 复用会话（不指定 session 的一次性会话跑完自动断开） |
| `--origin <o>` | string[] | 是* | 会话授权域（可重复传）；*CLI 不强制校验，漏传在首个域外动作报 `ORIGIN_NOT_ALLOWED`；MCP 侧为硬必填 |
| `--model-origin <o>` | string[] | 否 | 允许外发云模型的域（⊆ origin）；不给 = 禁止外发 |
| `--values <json>` | string | 否 | 变量初值（详见 2.3） |
| `--idempotency-key <k>` | string | 否 | 幂等键 |

预期输出（stderr 摘要，退出码 0）：

```text
status=done taskId=a1b2c3 revision=5
  step goto [action] done
  step read-heading [extract] done
  step verify-heading [assert] done
  step shot [action] done
artifacts: aXyz(screenshot.png,12345B)
```

#### 2.2 envelope 字段说明（`--json` 完整输出）

加 `--json` 后 stdout 输出完整 TaskEnvelope（字段与 `core/src/types.ts` 一致，下面为成功示例节选）：

```jsonc
{
  "schemaVersion": 1,
  "taskId": "a1b2c3",
  "sessionId": "s4d5e6",
  "mode": "execute",              // execute | run | act
  "revision": 5,                  // 乐观锁版本号（cancel/resume 可带 expectedRevision）
  "status": "done",               // queued/running/paused/cancelling/done/failed/expired/cancelled
  "stepResults": [                // 每步结果
    { "id": "goto", "kind": "action", "status": "done" },
    { "id": "read-heading", "kind": "extract", "status": "done", "savedAs": "heading" }
  ],
  "artifacts": [                  // 产物（artifact get / API 下载用）
    { "artifactId": "aXyz", "filename": "screenshot.png", "size": 12345 }
  ],
  "metrics": {
    "queuedMs": 3, "runningMs": 4210, "actions": 2,
    "jevRequests": 0, "plannerRequests": 0,          // 全 0 = 确定性执行，零模型调用
    "connectMs": 812, "inputTokens": 0, "outputTokens": 0
  }
  // 失败/暂停时另有：error{code,message,retryable,details}、pauseReason、
  // pendingApproval{actionRevision,action,reason}、goalVerification{by,ok,detail}、evidence[]
}
```

| 字段 | 含义 |
|---|---|
| `status` / `pauseReason` | 任务状态 / 暂停原因（见技术原理状态机） |
| `stepResults[]` | 每步 `{id, kind, status, error?}`（extract 另有 `savedAs`，动作另有 `artifactId`） |
| `error` | `{code, message, retryable, details?}` |
| `goalVerification` | run 的任务级验收：`{by: deterministic\|semantic, ok, detail}` |
| `pendingApproval` | 待审批时：`{actionRevision, action, reason}` + stderr 提示两条命令（见 2.7） |
| `metrics` | `queuedMs/runningMs/actions/jevRequests/plannerRequests`（必填）+ `connectMs/inputTokens/outputTokens/jevModel/plannerModel/replans`（可选） |
| `evidence` | 截图引用/概率/断言失败明细等证据 |

#### 2.3 `--values` 的三大用法

**用法一：参数化复用 flow**（flow 写逻辑，命令行传数据）。`search.flow.json`：

```json
[
  { "id": "go",   "kind": "action", "action": "navigate", "valuesRef": "startUrl",
    "expect": [ { "kind": "url_contains", "value": "bilibili" } ] },
  { "id": "kw",   "kind": "action", "action": "fill",
    "target": { "by": "css", "selector": "input.search-input" }, "valuesRef": "keyword",
    "expect": [ { "kind": "visible", "target": { "by": "css", "selector": ".search-btn" } } ] },
  { "id": "send", "kind": "action", "action": "press", "value": "Enter",
    "expect": [ { "kind": "url_contains", "value": "search" } ] }
]
```

```powershell
cli execute --file search.flow.json `
  --url "https://www.bilibili.com" --origin "https://www.bilibili.com" --origin "https://search.bilibili.com" `
  --values '{"startUrl":"https://www.bilibili.com","keyword":"虎皮鹦鹉"}'
# 换词重跑只改 --values：..."keyword":"玄凤鹦鹉"...，flow 一个字不动
```

解析规则（`executor.ts resolveValue`）：步骤写 `valuesRef` → 先查 `--values` 字典 → 查不到回退流程变量（如 `heading.text`）→ 都没有报 `INVALID_INPUT` 且**动作不派发**；没写 `valuesRef` 用步骤 `value` 字面值；引用到数组/未解析的 secretRef 均报错（动作输入必须是标量）。

**用法二：敏感值走 secretRef**（密码不进命令行/文件/日志）：

```powershell
$env:JEV_BROWSER_SECRET_LOGIN_PW = "真实密码"     # ① 密码只放环境变量（名字任意，前缀固定）
cli execute --file login.flow.json `
  --url "https://example.com/login" --origin "https://example.com" `
  --values '{"user":"zly","password":{"secretRef":"LOGIN_PW"}}'   # ② 命令行只写引用
```

```json
{ "id": "pw", "kind": "action", "action": "fill",
  "target": { "by": "css", "selector": "input[type=password]" }, "valuesRef": "password",
  "expect": [ { "kind": "visible", "target": { "by": "role", "role": "button", "name": "登录" } } ] }
```

忘设环境变量 → 任务**暂停** `needs_input` 并提示 `缺少 secret "LOGIN_PW"（环境变量 JEV_BROWSER_SECRET_LOGIN_PW）`；补上后 `task resume <taskId> --request-id r1` 继续。解析在内存完成，值不落盘、不进日志/账本/模型请求。

**用法三：与流程变量联动**（页面数据 → 下一步输入）。`--values` 的 key 与 `extract.saveAs` 同处一个回退链：

```json
[
  { "id": "抓验证码", "kind": "extract",
    "target": { "by": "css", "selector": ".sms-code" }, "fields": ["text"], "saveAs": "code" },
  { "id": "填验证码", "kind": "action", "action": "fill",
    "target": { "by": "css", "selector": "input.code" }, "valuesRef": "code.text",
    "expect": [ { "kind": "count_gte", "target": { "by": "css", "selector": ".code-filled" }, "value": 1 } ] }
]
```

注意 `valuesRef: "code.text"`：extract 存的是对象 `{text}`，引用要带点号（`code.text`）。页面数据只作为**值**使用，不会被解析成选择器或代码。

#### 2.4 长会话多命令（观察 → 决定 → 操作）

> ⚠️ launch 模式下浏览器属于启动进程：**裸 CLI 跨命令复用会话不可行**（旧会话报 `SESSION_NOT_READY`）。跨命令长会话二选一：`--api` 长驻模式（步骤 5）或 attach（步骤 3）。

会话命令参数表：

| 命令 | 参数 | 作用 |
|---|---|---|
| `connect` | `--url` 或 `--page`（必填）、`--origin`（必填*同 2.1）、`--model-origin`（可重复） | 建会话；多候选页时返回 `awaiting_page` + 候选清单（退出码 3） |
| `pages` | `--session`（必填） | 列标签页（按授权域过滤、URL 脱敏） |
| `select-page` | `--session` `--page`（必填） | 切换绑定页 |
| `snapshot` | `--session`（或一次性 `--url`/`--page`+`--origin`）；`--for-model` 旗标 | 只读快照；`--for-model` 表示要发云模型，要求当前页 origin ∈ modelOrigins |
| `act` | `--session` `--step`（必填）、`--values` | 单步动作（ActionStep JSON/文件/`-`） |
| `disconnect` | `--session`（必填）；`--detach-task` 旗标 | 断开；有暂停任务需显式 detach |

实测示例（无 key 可照抄，用 `--api` 长驻模式；B 站搜索并打开第 4 条结果）：

```powershell
# 终端 1：起长驻 API（浏览器归它持有）
$env:JEV_BROWSER_API_TOKEN = "<随机长串>"
$env:JEV_BROWSER_MODE = "launch"; $env:JEV_BROWSER_ENGINE = "chromium"; $env:JEV_BROWSER_HEADLESS = "true"
node api/dist/index.js

# 终端 2：以下命令都带 --api 与同一 token；$api = "--api http://127.0.0.1:3737"
# ① 建会话（搜索页与视频页是两个 origin，都要声明）
cli connect $api --url "https://search.bilibili.com/all?keyword=%E8%99%8E%E7%9A%AE%E9%B9%A6%E9%B9%89" --origin "https://search.bilibili.com" --origin "https://www.bilibili.com"
# ② 快照观察结果列表（确认渲染、看清标题与顺序）
cli snapshot $api --session <sessionId> --json
# ③ 点击第 4 条（推荐按②里看到的完整标题精确文本点击；flow 示例）
#    [ { "id":"wait", "kind":"action", "action":"wait", "target":{"by":"css","selector":".bili-video-card"}, "value":2000 },
#      { "id":"open", "kind":"action", "action":"click",
#        "target":{"by":"text","text":"<第4条完整标题>","exact":true},
#        "expect":[{"kind":"url_contains","value":"search.bilibili.com"}] },
#      { "id":"shot", "kind":"action", "action":"screenshot" } ]
cli execute $api --session <sessionId> --file bili-open4.flow.json
# ④⑤ 查看/切换 target=_blank 新开的视频页并验证
cli pages $api --session <sessionId>
cli select-page $api --session <sessionId> --page <新页id>
cli snapshot $api --session <sessionId>
# ⑥ 断开
cli disconnect $api --session <sessionId>
```

#### 2.5 场景教程：下载文件并保存

下载的关键机制：**点击步骤的 expect 里出现 `download_completed`，引擎会先注册下载等待、再触发点击**（消除竞态）；下载完成自动 saveAs 到该任务的受管 artifact 区，并把 artifactId 写入流程变量 `lastArtifact`。

```jsonc
// download.flow.json
[
  { "id": "go", "kind": "action", "action": "navigate", "value": "https://example.com/report",
    "expect": [ { "kind": "url_contains", "value": "example.com" } ] },
  { "id": "dl", "kind": "action", "action": "click",
    "target": { "by": "role", "role": "link", "name": "下载报表" },
    "expect": [ { "kind": "download_completed" } ]        // ← 触发"先等待后点击"的下载通道；下载完成本身就是后置条件
  },
  { "id": "shot", "kind": "action", "action": "screenshot" }   // 可选：留档页面状态
]
```

下载成功后 artifactId 会写入流程变量 `lastArtifact`，后续步骤可用 `valuesRef: "lastArtifact"` 引用（如填入表单、branch 判断）；可用断言 op 只有 `var_equals`（引用变量用 `variable` 字段，点号路径）。

```powershell
cli execute --file download.flow.json --url "https://example.com/report" --origin "https://example.com"
# 摘要输出 artifacts: aXyz(report-2026.xlsx,20480B) —— 文件在 <数据目录>\artifacts\<taskId>\

# 取回本地：
cli artifact list --task <taskId>
cli artifact get --task <taskId> --artifact aXyz --out .\report.xlsx
```

#### 2.6 FlowStep 契约速查（execute/act 的 steps 字段）

六种步骤（`id` 均必填）：

| kind | 专有字段 | 说明 |
|---|---|---|
| `action` | `action`：navigate/click/fill/press/select/scroll/wait/screenshot/upload；`target?`（LocatorSpec）；`value?`；`valuesRef?`（优先于 value）；`filePath?`（upload，必须在 allowedUploadDirs 内）；`expect: ExpectSpec[]` | **导航/写操作/下载必须提供 expect 后置条件** |
| `assert` | `expect: ExpectSpec[]` | 纯断言 |
| `extract` | `target`（必填）；`fields: ["text"\|"count"]`；`saveAs` | 存入 `vars[saveAs]={text?,count?}`，点号引用 |
| `branch` | `variable`、`equals`、`then: FlowStep[]` | 单层分支（不可嵌套 branch）；variable 读 vars/values 命名空间 |
| `forEach` | `itemsVar`、`itemVar`、`maxItems`（≤30）、`body: FlowStep[]` | 有界循环 + 断点续跑（见下） |
| `goal` | `goal`、`valuesRef?`、`expect` | Jev 局部语义循环（需 Jev key） |

LocatorSpec 白名单（模型不得生成任意 XPath/JS）：`role`（role/name?/exact?）、`label`（name/exact?）、`testId`（id）、`text`（text/exact?）、`css`（selector）。
ExpectSpec 的 kind：`url_contains` / `text_present` / `visible` / `hidden` / `count_gte` / `download_completed` / `var_equals`（变量引用用 `variable` 字段，点号路径）。

**forEach 语义与限制（如实说明）**：`itemsVar` 必须指向流程变量中**已存在的数组**（非数组报 `INVALID_INPUT`）；迭代上限 `min(maxItems, 30)`；每轮迭代结束落 checkpoint（`<itemsVar>.processed`），暂停/崩溃后恢复**不重放已执行副作用**；未处理完全部条目时暂停 `needs_input`（提示 `已处理 x/y`），恢复后从断点继续。**当前限制**：确定性步骤中只有 extract 写 vars（且只产 `{text,count}` 对象），没有产数组变量的步骤——forEach 主要服务于规划器产物与后续扩展；确定性批量场景可用 branch 或展开为多个步骤替代。

#### 2.7 自主任务 run 全流程（含高风险审批）

```powershell
$env:JEV_BROWSER_PLANNER_ENABLED = "true"
$env:JEV_BROWSER_PLANNER_BASE_URL = "https://api.deepseek.com/v1"
$env:JEV_BROWSER_PLANNER_MODEL = "deepseek-chat"
$env:JEV_BROWSER_PLANNER_API_KEY = "<规划模型 key>"     # 规划器与 Jev 是两份独立凭据
$env:TYPESAFE_API_KEY = "<Jev key>"
```

`run` 参数全表：

| 参数 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `--goal <文本>` | string | 是 | 自然语言目标 |
| `--success <文本>` | string | 是 | 人类可读验收条件（引擎校验，规划器不能自证完成） |
| `--url` / `--page` / `--session` | string | 三选一 | 目标页 |
| `--origin <o>` | string[] | 是（一次性会话） | 授权域 |
| `--model-origin <o>` | string[] | 否 | 可外发域（⊆ origin）；run 的任务级验收也要外发，不给会暂停 |
| `--values` / `--idempotency-key` | — | 否 | 变量 / 幂等键 |

```powershell
cli run `
  --url "https://search.bilibili.com/all?keyword=%E8%99%8E%E7%9A%AE%E9%B9%A6%E9%B9%89" `
  --goal "在当前B站搜索结果页，按顺序找到第4条视频结果并打开它" `
  --success "当前页是 bilibili 视频播放页（URL 含 /video/BV），且视频标题与搜索结果第4条一致" `
  --origin "https://search.bilibili.com" --origin "https://www.bilibili.com" `
  --model-origin "https://search.bilibili.com" --model-origin "https://www.bilibili.com"
```

**高风险动作的人工审批三步流**——动作目标名命中风险 pattern（支付/删除/发送/pay…）时任务暂停（`pendingApproval`），stderr 给出确切命令（**在另一个终端、以审批人身份**——签发 key 与执行侧不同源才构成边界）：

```powershell
# ① 签发一次性 grant（需环境变量 JEV_BROWSER_APPROVAL_KEY，与执行侧隔离保管）
$env:JEV_BROWSER_APPROVAL_KEY = "<审批密钥>"
cli grant create --task <taskId> --action-revision 7      # → 输出 grant token（--json 时输出 {grant, ttlMs}）
# ② 注入批准（grant 一次性、短 TTL、绑定 actionRevision，动作被改即失效）
cli task approve <taskId> --grant <token>
# ③ 恢复任务（request-id 幂等，重试安全）
cli task resume <taskId> --request-id r1
```

任务管理命令参数表（`<taskId>` 可位置式或 `--task`）：

| 子命令 | 参数 | 作用 |
|---|---|---|
| `task get <taskId>` | — | 查询 envelope |
| `task cancel <taskId>` | `--request-id`（缺省自动生成）、`--expected-revision <n>` | 取消（幂等+乐观锁） |
| `task resume <taskId>` | 同上 + `--rerun-confirm`、`--replan` | 恢复；未证实结果需前者；run 允许重规划未完成后缀（受 maxReplans） |
| `task approve <taskId>` | `--grant <token>`（必填） | 注入批准 |
| `artifact list / get` | `--task`（必填）；get 另需 `--artifact <id>` `--out <path>` | 产物列表 / 下载 |

#### 2.8 退出码与逐错误码排查

| 退出码 | 含义 | 处理 |
|---|---|---|
| 0 | done | — |
| 2 | 参数/配置错误（`CONFIG_INVALID`/`INVALID_INPUT`） | 按 stderr message 修正（严格校验指名道姓） |
| 3 | paused | 按 stderr 提示走审批流 / 补 values / model-origin |
| 4 | failed / expired（及未归类错误） | 看 `--json` 的 error 三要素与 evidence |
| 130 | cancelled | 主动取消或 Ctrl+C |

逐错误码排查步骤：

| 错误码 | 含义 | 排查 |
|---|---|---|
| `ORIGIN_NOT_ALLOWED` | 目标域没进授权 | `--origin` 补声明该域（注意搜索页/详情页常是两个 origin） |
| `CONFIG_INVALID` | 配置非法 | 看消息指名的字段；常见：attach+headless、attach+chromium（想无头/用 Chromium 就显式 `JEV_BROWSER_MODE=launch`） |
| `BROWSER_BUSY` | 连不上/起不来浏览器 | attach：见步骤 3 的授权教程；launch：profile 被占（另一实例在用）或 Chromium 未装（步骤 0） |
| `CAPABILITY_UNSUPPORTED` | 能力缺失 | 按提示执行 `npx playwright install chromium` 等 |
| `ACTION_FAILED`（后置条件未通过） | expect 没满足 | 看 `details.failures`：选择器不对/页面没跳转/文本不符；`snapshot` 先看页面实际结构 |
| `ACTION_OUTCOME_UNKNOWN` | 动作超时且无法证实结果 | 该 profile 被隔离（新写任务拒绝、只读放行）；人工核查页面后 `task resume --rerun-confirm` |
| `IDEMPOTENCY_CONFLICT` | 同幂等键不同请求体 | 换键或核对请求体；同体重放会返回原任务（这是特性不是错误） |
| `REVISION_CONFLICT` | 乐观锁冲突 | 重新 `task get` 拿最新 revision 再操作 |
| `JEV_NOT_CONFIGURED` / `PLANNER_NOT_CONFIGURED` | 语义步骤/run 缺凭据 | 按 2.7 配 `TYPESAFE_API_KEY` / planner 三件套 |
| `INVALID_INPUT`（valuesRef 不存在） | 引用了不存在的变量 | 核对 `--values` 的 key 与 extract 的 `saveAs`（点号路径） |

使用注意：iframe、开放 Shadow DOM 为受限能力（观察脚本不穿透闭合 Shadow DOM）；高风险动作放行后站点弹出的 confirm 仍按保守策略 dismiss。

### 步骤 3：attach 接管日常 Chrome 实战教程

attach = 借用你**已打开、已登录**的日常 Chrome（不新开实例、不复制 Cookie、断开时绝不关你的浏览器）。Chrome 144+ 采用授权式远程调试，完整流程：

**① 一次性开启授权**（每台机器一次）：

1. 确认 Chrome ≥ 144（地址栏 `chrome://version` 看 major 版本）；
2. 地址栏打开 `chrome://inspect/#remote-debugging`；
3. 勾选 **"Allow remote debugging for this browser instance"**。

**② 跑命令时盯住 Chrome 窗口点“允许”**：

```powershell
# 清掉 launch 相关覆盖（attach 是默认 mode，不要设 MODE/ENGINE/HEADLESS）
Remove-Item Env:JEV_BROWSER_MODE, Env:JEV_BROWSER_ENGINE, Env:JEV_BROWSER_HEADLESS -ErrorAction SilentlyContinue

cli doctor --connect        # 先单独验证：成功输出 [connect] OK: ...
cli execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```

连接发起后，**Chrome 窗口内会弹出一个连接确认框**——常见坑是它被其他窗口挡住：屏幕上看不到任何反应、命令像“卡住”，其实是在等你点「允许」。授权一次后，该来源的后续连接不再弹窗。

**③ 超时与调参**：每次 attach 尝试有**硬超时**保护（默认 60s，超时报 `BROWSER_BUSY` 并附指引），可用环境变量调整：

```powershell
$env:JEV_BROWSER_CONNECT_TIMEOUT_MS = "120000"   # 给自己更长时间找弹窗；或调小快速失败
```

**④ 故障特征速查**：

| 现象 | 含义 |
|---|---|
| 60s 超时 + 提示“等授权弹窗” | 弹窗没点（被遮挡）或从未开启授权 → 回 ①② |
| `Unexpected status 404 .../json/version` | Chrome 调试服务在、但本客户端未授权 → 回 ①② |
| `DevToolsActivePort file not found` | Chrome 没开远程调试（或用的不是默认用户数据目录）→ 回 ① |
| 授权后仍连不上 | `chrome://version` 确认 ≥144；重启 Chrome 后重试 |

> attach 路径在本仓库的实机验证仍在推进（P0），结论出来前不要把 attach 模式加入生产 MCP 配置；日常求稳用 launch 模式。

### 步骤 4：MCP 使用（Agent 宿主）

① 注册（嵌入模式：MCP 进程内直接跑 Runtime；路径必须绝对且指向构建产物）：

```json
{
  "mcpServers": {
    "jev-browser": {
      "command": "node",
      "args": ["D:/develop/GitNote/Redfish-AI/Tool/tools/jev-browser/mcp/dist/index.js"]
    }
  }
}
```

② （可选）API 转发模式：先起长驻 API（步骤 5），再给 MCP 进程加环境变量 `"env": {"JEV_BROWSER_API_URL": "http://127.0.0.1:3737", "JEV_BROWSER_API_TOKEN": "<token>"}`——多客户端共享同一次浏览器连接。

③ 14 个工具与参数全表（描述末尾带风险标签 readonly/write/control；执行错误返回 `{error:{code,message}}` + `isError:true`；execute/run/act 阻塞到任务落定，上限 30 分钟）：

| 工具 | 参数（粗体必填） | 说明 |
|---|---|---|
| `browser_doctor` | `connect?`（boolean） | 诊断；true=尝试接管【readonly】 |
| `browser_connect` | `url?`/`pageId?`（二选一）、**`allowedOrigins`**（string[]）、`modelOrigins?` | 建会话【control】 |
| `browser_pages` | **`sessionId`** | 列标签页【readonly】 |
| `browser_select_page` | **`sessionId`** **`pageId`** | 切页【control】 |
| `browser_snapshot` | **`sessionId`**、`forModel?` | 快照【readonly】 |
| `browser_execute` | **`sessionId`** **`steps`**（FlowStep[]）、`values?` | 确定性步骤【write】 |
| `browser_run` | **`sessionId`** **`goal`** **`successCriteria`**、`values?` | 自主任务【write】 |
| `browser_act` | **`sessionId`** **`step`**、`values?` | 单步动作【write】 |
| `browser_task_get` | **`taskId`** | 查询【readonly】 |
| `browser_task_cancel` | **`taskId`** **`requestId`**、`expectedRevision?` | 取消【control】 |
| `browser_task_resume` | **`taskId`** **`requestId`**、`expectedRevision?`、`rerunConfirmed?`、`allowReplan?` | 恢复【control】 |
| `browser_task_approve` | **`taskId`** **`grant`** | 审批【control】 |
| `browser_artifact_get` | **`taskId`** | 产物元信息【readonly】 |
| `browser_disconnect` | **`sessionId`**、`detachTask?` | 断开【control】 |

④ Agent 典型调用序列：

```text
browser_doctor {}                                          → 自检
browser_connect { url, allowedOrigins: ["https://..."] }   → 建会话（allowedOrigins 必填！）
browser_snapshot { sessionId }                             → 只读观察
browser_execute { sessionId, steps: [...], values: {} }    → 确定性步骤
browser_artifact_get { taskId }                            → 列产物
browser_disconnect { sessionId }                           → 收尾（暂停任务需 detachTask:true）
```

⑤ MCP 进程环境变量：所有 `JEV_BROWSER_*` 覆盖均生效；转发模式加 `JEV_BROWSER_API_URL/TOKEN`；身份 `JEV_BROWSER_MCP_PRINCIPAL`（默认 `mcp`）。

### 步骤 5：长驻 HTTP API 使用（多客户端共享 / 跨语言集成）

① 启动（token 必须设置，否则拒绝启动）：

```powershell
$env:JEV_BROWSER_API_TOKEN = "<随机长串>"
node api/dist/index.js --config "D:\config\jev-browser.json" --port 3737    # 默认 127.0.0.1:3737
```

启动参数：`--config <path>`、`--port <n>`（默认取配置 `api.port`；host 固定取配置 `api.host`，仅 loopback）。
安全基线：loopback + Bearer token + Host 校验（防 DNS rebinding）+ 无 CORS + 请求体 1MB 上限 + 写请求限速（默认 120/分）+ 并发上限（默认 16）+ artifact 下载 200MB 上限。

② 路由总表（均需 `-H "Authorization: Bearer <token>"`）：

| 方法与路径 | 请求体 | 响应 | 对应 CLI/MCP |
|---|---|---|---|
| `GET /v1/diagnostics` | — | 200 doctor | doctor / browser_doctor |
| `POST /v1/sessions` | `{target, allowedOrigins, modelOrigins}` | 201 会话 | connect |
| `GET /v1/sessions/:id/pages` | — | 200 `{pages}` | pages |
| `POST /v1/sessions/:id/page` | `{pageId}` | 200 | select-page |
| `POST /v1/sessions/:id/snapshot` | `{forModel}` | 200 快照 | snapshot |
| `POST /v1/sessions/:id/act` | `{step, values}` | 202 任务 | act |
| `POST /v1/tasks/execute` | `{sessionId, steps, values}`（可加 `Idempotency-Key` 头） | 202 任务 | execute |
| `POST /v1/tasks/run` | `{sessionId, goal, successCriteria, values}` | 202 任务 | run |
| `GET /v1/tasks/:id` | — | 200 `{envelope}` | task get |
| `GET /v1/tasks/:id/artifacts` | — | 200 `{artifacts}` | artifact list |
| `GET /v1/tasks/:id/artifacts/:artifactId` | — | 200 二进制流 | artifact get |
| `POST /v1/tasks/:id/cancel` | `{requestId, expectedRevision?}` | 200 `{envelope}` | task cancel |
| `POST /v1/tasks/:id/resume` | `{requestId, expectedRevision?, rerunConfirmed?, allowReplan?}` | 200 | task resume |
| `POST /v1/tasks/:id/approve` | `{grant}` | 200 | task approve |
| `DELETE /v1/sessions/:id?detachTask=true` | — | 200 | disconnect |

错误码→HTTP 状态：`NOT_FOUND`→404；`IDEMPOTENCY_CONFLICT`/`REVISION_CONFLICT`/`SESSION_BUSY`/`BROWSER_BUSY`/`TASK_NOT_RESUMABLE`/`NEEDS_CONFIRMATION`/`SESSION_NOT_READY`/`PAGE_NOT_RESOLVED`→409；`CONFIG_INVALID`/`INVALID_INPUT`→400；`GRANT_INVALID`/`ORIGIN_NOT_ALLOWED`/`POLICY_BLOCKED`→403；限速/并发→429；其余→500。202 提交后轮询 `GET /v1/tasks/:id` 至终态。

③ curl 最小闭环：

```powershell
curl http://127.0.0.1:3737/v1/diagnostics -H "Authorization: Bearer <token>"
curl -X POST http://127.0.0.1:3737/v1/sessions -H "Authorization: Bearer <token>" -H "content-type: application/json" `
  -d '{ "target": {"kind":"new","url":"https://example.com"}, "allowedOrigins": ["https://example.com"] }'
curl -X POST http://127.0.0.1:3737/v1/tasks/execute -H "Authorization: Bearer <token>" -H "content-type: application/json" `
  -d '{ "sessionId":"sXX", "steps":[...], "values":{} }'
curl http://127.0.0.1:3737/v1/tasks/<taskId> -H "Authorization: Bearer <token>"     # 轮询至终态
```

CLI 侧等价：任何命令加 `--api http://127.0.0.1:3737` 即自动走转发路径。

### 步骤 6：仓库启动器（统一 MCP 入口）

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list                # 应列出 jev-browser
node bin/tool-launcher.js build jev-browser   # 只装依赖并构建
node bin/tool-launcher.js jev-browser         # 以 MCP stdio 拉起（缺 dist 自动构建）
```
