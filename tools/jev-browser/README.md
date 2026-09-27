# jev-browser —— 浏览器控制工具（核心已实现，实机验证部分完成）

> 状态：`core + cli + mcp + api` 四包工作区已实现，62 个离线单元/集成测试通过（假件驱动，无需浏览器与模型 key）。
> **P0 实机验证已部分完成（2026-09-27）**：launch 路径（受管 Chromium，无头+独立临时 profile）端到端冒烟通过
> （`node scripts/smoke.mjs`，含导航/提取/断言/下载保真/截图/幂等/断开）；实测发现并修复 2 个缺陷
> （只读动作 expect 崩溃、产物不登记入库）。结果与复现步骤见 [docs/compatibility.md](docs/compatibility.md)。
> **attach 接管日常 Chrome 仍待验证**（需用户在 chrome://inspect 人工授权），暂不可用于生产，未列入根 README 的可用工具表。
> 方案版本：v0.2。本文的接口、配置和命令为实现契约；能力边界以 P0—P6 验收为准。

## 当前实现范围（对应开发计划）

| 能力 | 状态 |
| --- | --- |
| 严格配置合并/校验（env + JSON + CLI 覆盖，未知字段/类型/布尔拒绝） | 已实现，有测试 |
| 任务状态机、乐观 revision、动作账本（prepared/in_flight/verified/failed/unknown） | 已实现，有测试 |
| 幂等提交（Idempotency-Key，同键同体重放/异体冲突，24h 保留） | 已实现，有测试 |
| 高风险动作 → 暂停 needs_confirmation → HMAC grant 审批（一次性、绑定 actionRevision） | 已实现，有测试 |
| 超时未知动作 → profile 隔离（新写任务拒绝、只读放行、rerunConfirmed 解除） | 已实现，有测试 |
| forEach 断点续跑（processed 计数，恢复不重放副作用）、取消/恢复/过期回收 | 已实现，有测试 |
| secretRef（`JEV_BROWSER_SECRET_<NAME>`，内存解析不落盘） | 已实现，有测试 |
| Playwright 适配层（attach/launch、locator 白名单映射、download/dialog 端口） | 已实现；attach 行为待 P0 实测 |
| upload 动作（allowedUploadDirs 授权 + realpath 防穿越 + 秘密文件拒绝 + 大小预检，DESIGN §10） | 已实现，有测试 |
| 能力探测（DESIGN §11 全部 12 项；未实测标 unverified，不冒充 supported） | 已实现，有测试 |
| HTTP 速率/并发限制（DESIGN §10；RateLimiter 固定窗口 + 并发上限） | 已实现，有测试 |
| run 重规划（resume 显式 allowReplan，只改未完成后缀，受 maxReplans 预算，DESIGN §7） | 已实现，有测试 |
| §11 细粒度度量（connectMs、每步 durationMs、goal rounds、模型实际版本、envelope.evidence） | 已实现 |
| 快照串行化（经 profile 队列；跨会话预约期间拒绝窃读，DESIGN §8.3） | 已实现，有测试 |
| Jev 局部循环（fan-out、候选切片、阈值映射、modelOrigins 外发约束） | 已实现；需真实 key 联调 |
| openai-compatible 规划器（schema 白名单校验、一次修复请求） | 已实现；需真实服务联调 |
| MCP（14 工具）/ HTTP API（loopback + token + Host 校验）/ CLI 三入口 | 已实现，冒烟通过 |

## 目标

为 Agent、CLI 和 HTTP API 提供同一套浏览器控制能力：Playwright 执行操作，Jev 处理页面语义判断，可选的大模型规划器处理完整任务。优先缩短可靠完成任务的总时间，而不是单次请求的返回时间。

沿用仓库“核心逻辑与提供方式分离”的规范：`core` 是业务和工具元数据的单一事实来源；`cli`、`mcp`、`api` 是薄适配层。参考项目为 Ying-Kai-Liao/jev-browser，不直接把其整个服务套一层转发。

## 已确认的设计

| 项目 | 决定 |
| --- | --- |
| 默认浏览器 | 接管用户已打开的日常 Google Chrome，复用既有登录状态和标签页 |
| 默认显示模式 | 有头；无头仅适用于工具新启动的浏览器 |
| 配置渠道 | 环境变量和 JSON 配置文件；CLI 可提供显式覆盖 |
| 浏览器切换 | 可显式改为 Playwright 管理的 Chromium；不在连接失败时静默换浏览器 |
| `execute`（A） | 接受明确步骤或单一、可验证的结果目标；不调用内部规划大模型 |
| `run`（B） | 接受需要拆解的完整目标，使用可选规划器，再复用同一执行引擎 |
| 调用入口 | Agent/MCP、CLI、HTTP API 均支持两种模式，不按入口决定 A/B |
| 规划负责人 | 一个任务阶段只有一个；外部 Agent 已有计划时，不在内部重复规划 |
| 首版写入边界 | 只读 + 下载 + 低风险确定性写；发送/购买/删除等高风险动作一律暂停，待可信审批通道（P5）验收后再开放 |
| 退出行为 | 断开接管连接，不关闭用户 Chrome、既有 context 或既有标签页 |

“Playwright 模拟的浏览器”在本方案中解释为 Playwright 安装、管理的真实 Chromium 浏览器，不是 DOM 模拟器。首版不承诺 Firefox、WebKit 或视觉坐标式通用桌面控制。

## 文档导航

1. [DESIGN.md](DESIGN.md)：架构、浏览器连接、任务契约、配置、安全与效率设计。
2. [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)：分阶段工作、依赖、验收门槛、基准测试和交付清单。
3. [RESEARCH.md](RESEARCH.md)：本地规范、参考项目差异、官方资料、假设与待验证项。

## 两种模式如何选择

```text
Agent / CLI / HTTP API
          │
    同一组输入/输出契约
          │
     ┌────┴─────┐
  execute       run
  已有步骤      完整目标
  不做总规划    可选大模型规划器
     └────┬─────┘
       执行引擎
          │
    确定性操作 → Playwright
    页面语义判断 → Jev → Playwright
          │
     结果验证 / 暂停 / 恢复
```

- 已知流程直接 `execute`，不要为了“智能”再规划一次。
- 单个页面目标也可 `execute`，其内部允许多轮 Jev 判断与操作。
- 复杂目标用 `run`，在工具内部处理计划调整；不要让外部 Agent 同时重复拆解同一任务。
- 两种模式都支持批量步骤、逐步验证、长连接复用和失败后返回证据。
- 不承诺 A 或 B 永远更快；在相同成功率、安全约束、浏览器状态和计时范围下测试。

## 底层实现原理

一个核心引擎（`core`）+ 三个薄适配器（CLI/MCP/HTTP API）。Playwright 负责真实浏览器操作，代码断言负责「可计算的事实」，Jev 只兕「语义不确定」的底，规划 LLM 只在 `run` 模式拆解目标——四者严格分层。

```text
CLI（argparse）   MCP（stdio, 14 工具）   HTTP API（loopback+token）
      └──────────── 同一套 Runtime（core）────────────┘
                              │
   ┌──────────────┬───────────┴──────────┬──────────────┐
   │ 连接层        │ 持久化/状态层         │ 执行层        │
   │ connectors   │ store+statemachine   │ FlowExecutor │← 确定性步骤（0 模型）
   │ (attach/     │ +taskservice(Runtime)│ GoalExecutor │← Jev 局部循环
   │  launch)     │ SQLite 单库事务        │ Planner      │← 可选，仅 run
   └──────────────┴──────────────────────┴──────────────┘
```

1. **连接层（connectors.ts）——先分清浏览器是谁的**：
   - `attach`（借用，默认）：`connectOverCDP('chrome')` 哨兵走 Playwright 固定版本的 channel 发现，失败回退读默认用户目录 `DevToolsActivePort`；`noDefaults:true` 保证绝不 newContext 冒充用户会话、绝不关用户浏览器，`close()` 仅断开 CDP；显式端点只收 loopback（防页面/模型注入远程地址）。
   - `launch`（自有）：`launchPersistentContext` + 按 engine 独立 profile 目录，可安全关闭；报错区分「未安装」与「profile 被占」。
   - 其余层只依赖 `ports.ts` 结构接口，Playwright 类型被隔离在这一个文件。
2. **状态层——SQLite 单库事务**：tasks/会话/动作账本/幂等记录/审批 grant/artifact/预约锁同库原子提交。任务状态机是显式转移表（重启只落 `paused(interrupted)`/`expired`，绝不自动回 running）；动作账本 `prepared→in_flight→verified/failed/unknown`，非幂等动作超时先查证、不确定即隔离；`Idempotency-Key` 同体重放返回原任务、异体冲突；cancel/resume 带乐观 `expectedRevision`。
3. **执行层——三个执行器，模型权限递增**：
   - `FlowExecutor`（确定性）：顺序 action/assert/extract + 单层 branch + 有界 forEach；写操作强制 expect 后置条件，验证全部代码断言（url_contains/text_present/visible/count_gte/var_equals），0 次模型调用；checkpoint 断点续跑不重放副作用。
   - `GoalExecutor`（Jev 局部循环）：观察 → Jev fan-out → 策略校验 → 执行一个动作 → 差量再观察。Jev 只做闭集判断（选项/是否），不生成自由文本；候选超 200 先按关键词相关筛选；阈值映射（done≥0.85、blocked/error≥0.7、中间带需二次确认），歧义即暂停不猜。
   - `Planner`（仅 run）：OpenAI 兼容端点产短计划，输出必须过 schema 白名单（只能产出已定义步骤，一次受控修复），然后**复用同一个 FlowExecutor**——B 模式不是另一套引擎。
4. **安全模型**：双层 origin（`allowedOrigins` 会话可碰域 ∪ `modelOrigins` 可外发云模型域，后者⊆前者，空=默认禁止外发）；PolicyGate 每动作前综合判定（动作类型+目标名+域），命中风险 pattern（支付/删除/发送/pay…）一律 `paused+needs_confirmation`；解锁靠 HMAC grant——一次性、短 TTL、绑定 actionRevision，签发 key 是执行 Agent 不持有的凭据；`secretRef` 环境变量内存解析，不落盘不进模型请求体。
5. **细节边界**：下载先注册 download 等待再触发点击（消除竞态）→ saveAs 受管 artifact 区（落盘后原子登记进库）；对话框默认保守 dismiss，仅显式 `armOnce` 的预期 confirm 才接受且一次性；观察脚本内置固定白名单，不执行模型生成的 JS；所有错误带 `code/message/action` 三要素，`envelope.evidence` 存概率/截图/断言明细。

## 默认接管方式与边界

优先验证 Chrome 原生授权远程调试 + Playwright CDP 直连；不是默认安装扩展，也不是每一步再经过另一个浏览器 MCP 服务。

官方资料支持 Chrome 144 及以上通过 `chrome://inspect/#remote-debugging` 开启并授权调试连接；Playwright 的固定版本实现也提供了 Chrome channel 端点发现。此方案仍须通过 P0 的本机验证，不把文档证据等同于你的电脑已经可用。详见 [研究记录 S3—S6](RESEARCH.md)。

必须明确：

- 工具不能在未授权情况下无条件接管任意已打开的 Chrome。
- 传统 `--remote-debugging-port` 启动方式受默认用户数据目录限制，不能把它当作日常主配置文件的通用接管方案。
- 已打开的有头 Chrome 不能因配置 `headless=true` 而变成无头。需要显式选择 `launch`，启动另一个实例。
- 新启动的 Chromium/独立 Chrome 不会自动继承日常 Chrome 的全部登录状态；不复制主 profile、不导出全部 Cookie。

## 配置示意

默认（完整字段见 DESIGN §5.2；可直接复制的文件见 [examples/](examples/)）：

```json
{
  "schemaVersion": 1,
  "browser": {
    "mode": "attach",
    "engine": "chrome",
    "headless": false,
    "attach": {
      "endpoint": "chrome",
      "noDefaults": true
    }
  },
  "planner": {
    "enabled": false
  }
}
```

切换为工具管理的无头 Chromium：

```json
{
  "schemaVersion": 1,
  "browser": {
    "mode": "launch",
    "engine": "chromium",
    "headless": true
  }
}
```

PowerShell 环境变量示意（可直接覆盖上面的配置，未激活的 attach 子对象保留但不使用）：

```powershell
$env:JEV_BROWSER_MODE = "launch"
$env:JEV_BROWSER_ENGINE = "chromium"
$env:JEV_BROWSER_HEADLESS = "true"
```

attach/launch 配置按分支存放，只启用当前 mode 对应参数，无需为切换环境变量删除原配置；未知字段仍报错，attach + headless=true 仍不能隐式变成 launch。两种引擎使用不同工具 profile，避免混写。

默认不许可任何网站：实际使用需在可信配置中声明 `safety.allowedOrigins`；云模型可见的域另外放入 `safety.modelOrigins`。示例：只读 Example Domain 时可配置 `allowedOrigins: ["https://example.com"]`，纯确定性步骤保持 `modelOrigins: []`。API/MCP 任务只能从宿主已许可域中选子集，不能自行扩大权限。

开启自主模式需另外配置规划模型；Jev 的 API key 不能代替规划模型凭据。缺少规划器时 `run` 返回明确错误，不自动猜模型、供应商或费用预算。

## 接入方式与使用步骤

共四种接入方式：**CLI**（人/脚本，最直接）、**MCP**（Agent 宿主）、**HTTP API**（长驻共享）、**启动器**（仓库统一入口）。前三种共享同一个 core，行为与输出契约完全一致，按使用场景选其一即可。

---

### 第 0 步：前置条件与构建（所有方式共同前置）

**① 环境要求**

| 项 | 要求 | 说明 |
|---|---|---|
| Node | ≥ 24 | 任务库用 `node:sqlite`（24 起内置），低版本启动即报错 |
| 浏览器 | 二选一 | `launch` 模式：Playwright 管理的 Chromium（可自动装）；`attach` 模式：本机 Chrome ≥ 144 + 人工授权（P0 未验收，暂勿生产用） |

**② 安装依赖并构建**

```powershell
cd tools/jev-browser          # 或你的 jev-browser 目录
npm install                   # 装 playwright / @typesafe-ai/sdk 等（workspace 自动链接 core/cli/mcp/api）
npm run build                 # tsc -b，产出各包 dist/
```

验证构建成功：

```powershell
node cli/dist/index.js help        # 打印命令帮助 → 说明 CLI 入口可用
npm test                           # 62 个离线测试，无需浏览器/key，应全绿
```

**③ 浏览器运行时就绪（launch 模式）**

Playwright 1.63 需要 chromium revision 1243。首次以 launch 模式运行时若报
`Playwright 管理的 Chromium 未安装`，执行一次（约 115MB，国内可加镜像环境变量）：

```powershell
$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://cdn.npmmirror.com/binaries/playwright"
npx playwright install chromium
```

装到用户级缓存 `%LOCALAPPDATA%\ms-playwright\`，所有项目共用，装一次即可。

**④ 安装自检（重要）**

```powershell
node cli/dist/index.js doctor      # 检查 node/dataDir/凭据 + 能力表
node scripts/smoke.mjs             # 端到端冒烟：本地 fixture + 受管 Chromium，输出 "result": "go" 即就绪
```

`doctor` 的 credentials 行显示 `未配置` 是正常的——**纯确定性 execute 不需要任何 key**。

---

### 方式一：CLI（推荐上手路径）

入口统一为 `node cli/dist/index.js <命令>`。

#### 1.1 一次性确定性任务（最短路径，跑通第一条命令）

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```

逐参数说明：

| 参数 | 作用 | 不给会怎样 |
|---|---|---|
| `--file <path>` | FlowStep 步骤数组文件（也可 `--steps '[...]'` 内联） | 报参数错误 |
| `--url <url>` | 新开标签页并导航到此地址（会话目标） | `--url`/`--page` 至少给一个 |
| `--origin <url>` | **会话授权域**，可重复传多个；默认不许可任何网站，此域外的导航/动作一律拒绝 | 报参数错误（必填） |

预期输出（stderr 人读摘要 + 退出码 0）：

```text
status=done taskId=a1b2c3 revision=5
  step nav [action] done
  step read-heading [extract] done
  step verify-heading [assert] done
  step shot [action] done
artifacts: aXyz(screenshot.png,12345B)
```

加 `--json` 则 stdout 输出完整 envelope（`status/stepResults/artifacts/metrics/error` 字段），供脚本解析。全程 **0 次模型调用**（metrics 里 `plannerRequests=0, jevRequests=0`）。

不指定 `--session` 时这是一次性会话：跑完自动 disconnect。常用可选参数：

| 参数 | 作用 |
|---|---|
| `--values '{"name":"值"}'` | 变量初值，步骤内 `${name}` 引用；敏感值用 `{"secretRef":"NAME"}`（读环境变量 `JEV_BROWSER_SECRET_<NAME>`，不落盘） |
| `--session <id>` | 复用已有会话（见 1.2），跑完不自动断开 |
| `--idempotency-key <key>` | 幂等键：同键同体重放返回原任务，防脚本重跑造成重复副作用 |

#### 1.2 长会话多命令（观察/操作既有页面）

适合「先看看页面上有什么，再决定做什么」的交互式使用。ref 与页面状态在会话内跨命令保留。

> ⚠️ **launch 模式关键限制**：浏览器实例属于启动它的那个 CLI 进程，进程退出浏览器随之关闭——
> 因此**裸 CLI 跨命令复用会话不可行**（新进程看到的是新浏览器，旧会话报 `SESSION_NOT_READY`）。
> 跨命令长会话必须二选一：**`--api` 长驻模式**（方式三，浏览器由 API 进程持有；下面的实测示例用此法）或 **attach 接管日常 Chrome**（浏览器本来就独立存活）。

**实测示例（无 key，可照抄）：打开 B 站搜索「虎皮鹦鹉」，打开第 4 条结果**

```powershell
# 终端 1：起长驻 API（浏览器归它持有）
$env:JEV_BROWSER_API_TOKEN = "<随机长串>"
$env:JEV_BROWSER_MODE = "launch"; $env:JEV_BROWSER_ENGINE = "chromium"; $env:JEV_BROWSER_HEADLESS = "true"
node api/dist/index.js

# 终端 2：以下命令都带 --api 与同一 token
$env:JEV_BROWSER_API_TOKEN = "<同一token>"
$api = "--api http://127.0.0.1:3737"

# ① 建会话：注意搜索页与视频页是两个 origin，都要声明
node cli/dist/index.js connect $api --url "https://search.bilibili.com/all?keyword=%E8%99%8E%E7%9A%AE%E9%B9%A6%E9%B9%89" --origin "https://search.bilibili.com" --origin "https://www.bilibili.com"

# ② 快照观察结果列表（确认结果已渲染、看清各条标题与顺序）
node cli/dist/index.js snapshot $api --session <sessionId> --json

# ③ 点击第 4 条（三种写法任选其一，写进 flow 文件后执行）：
#    a) 精确文本（推荐，最稳）：先从②确认第4条标题，再按文本点击
#    b) CSS 序数：":nth-match(.bili-video-card a[href*='video/BV'], 4)" —— 注意 B 站每卡有多个 BV 链接，序数≠卡号，需先探针确认
#    c) goal 语义步骤（需 Jev key）
#    flow 示例（a 方案；B 站卡片 target=_blank 会开新标签页，会话页仍留在搜索页，故 expect 校验会话页 URL）：
#    [ { "id":"wait", "kind":"action", "action":"wait", "target":{"by":"css","selector":".bili-video-card"}, "value":2000 },
#      { "id":"open", "kind":"action", "action":"click",
#        "target":{"by":"text","text":"<第4条完整标题>","exact":true},
#        "expect":[{"kind":"url_contains","value":"search.bilibili.com"}] },
#      { "id":"shot", "kind":"action", "action":"screenshot" } ]
node cli/dist/index.js execute $api --session <sessionId> --file bili-open4.flow.json

# ④ 查看新开的标签页（视频页 target=_blank，会出现在 pages 列表里）
node cli/dist/index.js pages $api --session <sessionId>

# ⑤ 切换到视频页并快照验证（标题应与第 4 条一致；URL 带 spm_id_from=…search-card.all.click）
node cli/dist/index.js select-page $api --session <sessionId> --page <新页id>
node cli/dist/index.js snapshot $api --session <sessionId>

# ⑥ 断开（API 进程持有的浏览器随之可回收；Ctrl+C 结束终端 1）
node cli/dist/index.js disconnect $api --session <sessionId>
```

```powershell
# ① 建会话：--url 开新页，或 --page <id> 绑定已打开的标签页
node cli/dist/index.js connect --url "https://example.com" --origin "https://example.com"
# → 返回 JSON，记下 "sessionId": "sXXXX"

# ② 列出该浏览器所有标签页（按授权域过滤、URL 脱敏）
node cli/dist/index.js pages --session sXXXX

# ③ 如有多页，选定要操作的那页
node cli/dist/index.js select-page --session sXXXX --page p0

# ④ 只读快照：结构化观察页面（accessibility 树）
node cli/dist/index.js snapshot --session sXXXX
#    --for-model：打算把快照发给云模型时必须加，且要求当前页 origin ∈ modelOrigins（connect 时用 --model-origin 声明）

# ⑤ 执行单个动作（ActionStep JSON；写操作需 expect 后置条件）
node cli/dist/index.js act --session sXXXX --step "{\"id\":\"c1\",\"kind\":\"action\",\"action\":\"click\",\"target\":{\"by\":\"role\",\"role\":\"link\",\"name\":\"More information\"},\"expect\":[{\"kind\":\"url_contains\",\"value\":\"iana.org\"}]}"

# ⑥ 取回产物（截图/下载文件）
node cli/dist/index.js artifact list --task <taskId>
node cli/dist/index.js artifact get --task <taskId> --artifact <artifactId> --out ./shot.png

# ⑦ 断开会话（有暂停任务时需 --detach-task 显式剥离）
node cli/dist/index.js disconnect --session sXXXX
```

#### 1.3 自主任务 run（内部规划，需先配 key）

前置配置（配置文件或环境变量均可，优先级 CLI > 环境变量 > 文件 > 默认值）：

```powershell
# 规划器（OpenAI 兼容端点）
$env:JEV_BROWSER_PLANNER_ENABLED = "true"
$env:JEV_BROWSER_PLANNER_BASE_URL = "https://api.deepseek.com/v1"
$env:JEV_BROWSER_PLANNER_MODEL = "deepseek-chat"
$env:JEV_BROWSER_PLANNER_API_KEY = "<你的规划模型 key>"     # 默认 apiKeyEnv 指向它
# Jev 判断（与规划器是两份独立凭据）
$env:TYPESAFE_API_KEY = "<你的 Jev key>"                    # 默认 apiKeyEnv；可用 JEV_BROWSER_JEV_API_KEY_ENV 改指向
```

执行：

```powershell
# 真实示例：B 站搜索结果里打开第 4 条视频（注意两个 origin 都要授权；
# 结果在新标签页打开，验收条件描述的是「点开之后」的状态）
node cli/dist/index.js run `
  --url "https://search.bilibili.com/all?keyword=%E8%99%8E%E7%9A%AE%E9%B9%A6%E9%B9%89" `
  --goal "在当前B站搜索结果页，按顺序找到第4条视频结果并打开它" `
  --success "当前页是 bilibili 视频播放页（URL 含 /video/BV），且视频标题与搜索结果第4条一致" `
  --origin "https://search.bilibili.com" --origin "https://www.bilibili.com" `
  --model-origin "https://search.bilibili.com" --model-origin "https://www.bilibili.com"

# 无 key 替代：确定性 execute（点击已知标题）+ 长驻 API，见 1.2 实测示例
```

- `--goal`：自然语言目标；`--success`：**人类可读验收条件**（引擎校验，规划器不能自证完成）
- `--model-origin`：允许页面数据外发云模型的域（必须 ⊆ `--origin`）；不给 = 禁止外发，任务级验收会暂停
- 内部：规划器产短计划（schema 白名单校验）→ 复用确定性执行引擎 → Jev 语义判断兜底；预算受 `runtime.maxSteps/maxReplans/maxInputTokens` 等硬上限约束

#### 1.4 高风险动作的人工审批（三步流）

动作目标名命中风险 pattern（支付/删除/发送/pay/delete…）时任务暂停，stderr 会提示：

```text
待审批: actionRevision=7 action=click 原因=目标名命中高风险 pattern "删除"
批准方式: grant create --task <taskId> --action-revision 7 然后 task approve <taskId> --grant <token>
```

照做即可（**需在另一个终端、以审批人身份**；签发 key 与执行 Agent 不同源才构成边界）：

```powershell
# ① 签发一次性 grant（需环境变量 JEV_BROWSER_APPROVAL_KEY，与执行侧隔离保管）
$env:JEV_BROWSER_APPROVAL_KEY = "<审批密钥>"
node cli/dist/index.js grant create --task <taskId> --action-revision 7
# → 输出 grant token

# ② 注入批准（grant 一次性、短 TTL、绑定 actionRevision，动作被改即失效）
node cli/dist/index.js task approve <taskId> --grant <token>

# ③ 恢复任务（request-id 幂等，重试安全）
node cli/dist/index.js task resume <taskId> --request-id r1
```

其它任务操作：`task get <id>` 查询；`task cancel <id> --request-id r1` 取消；超时未知动作恢复需 `task resume <id> --request-id r1 --rerun-confirm`；run 任务允许重规划加 `--replan`。

#### 1.5 退出码与排错

| 退出码 | 含义 | 处理 |
|---|---|---|
| 0 | done | — |
| 2 | 参数/配置错误（含 `CONFIG_INVALID`/`INVALID_INPUT`） | 按 stderr 的 error.message 修正（严格校验：未知字段/类型错都会指名道姓） |
| 3 | paused（待审批/待输入/待选页） | 按 stderr 提示走 1.4 审批流或补 `--page`/values |
| 4 | failed / expired | 看 envelope.error 的 code/message/action 三要素；`--json` 拿完整证据 |
| 130 | cancelled | 主动取消或 Ctrl+C |

常见错误码：`ORIGIN_NOT_ALLOWED`（目标域没进 `--origin`，补声明或改目标）；`BROWSER_BUSY`（launch 时 profile 被占/attach 失败，按提示处理）；`CAPABILITY_UNSUPPORTED`（如 Chromium 未安装，见第 0 步③）；unknown 隔离（按提示 `--rerun-confirm` 或人工核查后恢复）。

---

### 方式二：MCP Server（Agent 宿主接入）

stdio 传输，14 个工具。两种运行模式：

**① 注册到 MCP 客户端**（嵌入模式：MCP 进程内直接跑 Runtime）：

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

> 路径必须是**绝对路径**且指向构建产物 `mcp/dist/index.js`；客户端启动工作目录不可控，不要写相对路径。

**② （可选）API 转发模式**：多客户端共享同一次浏览器连接。先按方式三起长驻 API，再给 MCP 进程加两个环境变量：

```json
{ "env": { "JEV_BROWSER_API_URL": "http://127.0.0.1:3737", "JEV_BROWSER_API_TOKEN": "<与 API 一致的 token>" } }
```

**③ 验证**：客户端里应看到 14 个工具（`browser_doctor / browser_connect / browser_pages / browser_select_page / browser_snapshot / browser_execute / browser_run / browser_act / browser_task_get / browser_task_cancel / browser_task_resume / browser_task_approve / browser_artifact_get / browser_disconnect`）。先调 `browser_doctor` 确认环境，再开始用。

**④ Agent 典型调用序列**（与 CLI 命令一一对应）：

```text
browser_doctor {}                                          → 环境自检
browser_connect { url, allowedOrigins: ["https://..."] }   → 建会话（origin 必填！）
browser_snapshot { sessionId }                             → 只读观察
browser_execute { sessionId, steps: [...], values: {} }    → 确定性步骤
browser_artifact_get { taskId }                            → 列产物
browser_disconnect { sessionId }                           → 收尾（有暂停任务需 detachTask:true）
```

**⑤ MCP 进程可用环境变量**：所有 `JEV_BROWSER_*` 配置覆盖均生效（如 `JEV_BROWSER_MODE/ENGINE/HEADLESS`）；转发模式加 `JEV_BROWSER_API_URL/TOKEN`；身份标识 `JEV_BROWSER_MCP_PRINCIPAL`（默认 `mcp`）。

---

### 方式三：长驻 HTTP API（多客户端共享 / 脚本集成）

仅监听 loopback（127.0.0.1），Bearer token 鉴权 + Host 校验。适合：多个 MCP 客户端共享一次 CDP 连接、CI 脚本、跨语言集成。

**① 启动服务**（token 必须设置，否则拒绝启动）：

```powershell
$env:JEV_BROWSER_API_TOKEN = "<随机长串>"
node api/dist/index.js --config "D:\config\jev-browser.json"
# 默认 127.0.0.1:3737（可由配置 api.host/port 修改）
```

**② 全流程调用**（curl 示例，均需 `-H "Authorization: Bearer <token>"`）：

```powershell
# 健康诊断
curl http://127.0.0.1:3737/v1/diagnostics -H "Authorization: Bearer <token>"

# 建会话
curl -X POST http://127.0.0.1:3737/v1/sessions -H "Authorization: Bearer <token>" `
  -H "content-type: application/json" `
  -d '{ "target": {"kind":"new","url":"https://example.com"}, "allowedOrigins": ["https://example.com"] }'

# 提交确定性任务（202 + taskId；幂等可加 Idempotency-Key 头）
curl -X POST http://127.0.0.1:3737/v1/tasks/execute ... -d '{ "sessionId":"sXX", "steps":[...], "values":{} }'

# 轮询任务直到终态（status ∈ done/failed/paused/expired/cancelled）
curl http://127.0.0.1:3737/v1/tasks/<taskId>

# 产物列表与下载
curl http://127.0.0.1:3737/v1/tasks/<taskId>/artifacts
curl http://127.0.0.1:3737/v1/tasks/<taskId>/artifacts/<artifactId> -o shot.png

# 取消/恢复/审批；断开会话
curl -X POST http://127.0.0.1:3737/v1/tasks/<taskId>/cancel -d '{ "requestId":"r1" }'
curl -X DELETE http://127.0.0.1:3737/v1/sessions/<sessionId>
```

路由总表：`GET /v1/diagnostics`；`POST /v1/sessions`；`GET /v1/sessions/:id/pages`；`POST /v1/sessions/:id/page|act|snapshot`；`POST /v1/tasks/execute|run`；`GET /v1/tasks/:id`；`GET /v1/tasks/:id/artifacts[/:artifactId]`；`POST /v1/tasks/:id/cancel|resume|approve`；`DELETE /v1/sessions/:id`。

---

### 方式四：仓库统一启动器

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list            # 确认识别（workspace 布局：存在 mcp/dist/index.js）
node bin/tool-launcher.js jev-browser     # 以 MCP stdio 方式拉起；缺 dist 自动触发构建
```

适合作为 MCP 客户端的统一 command（等价于方式二，无需手写各工具的绝对路径）。

---

### 配置与数据位置速查

| 项 | 位置/说明 |
|---|---|
| 配置优先级 | CLI 参数 > 环境变量（`JEV_BROWSER_*`）> JSON 配置文件 > 默认值；严格合并，未知字段/类型错直接拒绝 |
| 配置文件默认位置 | `%LOCALAPPDATA%\AI-Redfish\jev-browser\config.json`（可用 `--config` 显式指定） |
| 可复制示例 | `examples/config.attach-chrome.json`（接管日常 Chrome）、`config.chromium-headless.json`（自管无头 Chromium）、`read-page.flow.json`（最小流程） |
| 数据目录 | `%LOCALAPPDATA%\AI-Redfish\jev-browser\`：任务库 SQLite、`artifacts/<taskId>/`（截图/下载）、`profiles/<engine>/`（launch 的浏览器 profile） |
| 高频环境变量 | `JEV_BROWSER_MODE/ENGINE/HEADLESS`（浏览器形态）、`JEV_BROWSER_CDP_ENDPOINT`（显式 attach 端点）、`JEV_BROWSER_DATA_DIR`（数据目录）、`JEV_BROWSER_API_TOKEN`（API 鉴权）、`JEV_BROWSER_APPROVAL_KEY`（审批签发）、`JEV_BROWSER_SECRET_<NAME>`（secretRef 解析） |

## 当前交付与下一步

四包工作区、执行引擎、安全/审批/恢复机制与三入口适配器已实现并通过离线测试；启动器 `list` 已能识别本目录，`node bin/tool-launcher.js jev-browser` 可拉起 MCP（构建后）。
P0 已部分完成：launch 路径端到端冒烟通过（`npm run build && node scripts/smoke.mjs`），三入口（CLI/MCP 14 工具/启动器）实机验证通过，失败路径诊断可操作；**attach 接管路径仍需用户在 Chrome 授权后专项验证**（清单见 [docs/compatibility.md](docs/compatibility.md) §3）。结论出来之前，不要把 attach 模式加入生产 MCP 配置。

使用入口见上一节；attach 模式的 P0 结论出来之前，不要把它加入生产 MCP 配置；对真实站点的端到端表现待 P0 剩余项完成后复核。

```powershell
cd tools/jev-browser
pnpm install && pnpm build          # 或 npm install && npm run build

# 诊断（不连接浏览器）
node cli/dist/index.js doctor

# 尝试接管日常 Chrome（需 Chrome ≥ 144 在 chrome://inspect/#remote-debugging 授权）
node cli/dist/index.js doctor --connect

# 执行确定性流程（模型调用为 0；示例见 examples/）
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"

# 长驻本地 HTTP 服务（loopback + token）
$env:JEV_BROWSER_API_TOKEN = "<随机token>"; node api/dist/index.js

# 在仓库根目录中，统一入口仍然是 MCP
# node bin/tool-launcher.js jev-browser

# P0 冒烟：launch 路径端到端（本地 fixture + 受管 Chromium 无头 + 临时 profile，不碰用户 Chrome）
node scripts/smoke.mjs
```

审查发现与验证记录见 [RESEARCH.md](RESEARCH.md)；实现阶段的已知限制：

- iframe、开放 Shadow DOM、上传为受限/后置能力，观察脚本不穿透闭合 Shadow DOM（DESIGN §6.2）。
- 高风险动作的对话框确认接受属 P5 审批里程碑；首版 grant 消费后动作放行，但站点弹出的 confirm 仍按保守策略处理。
- `attach.endpoint` 的 `chrome` 哨兵依赖固定版本 Playwright 的 channel 发现语义，失败时回退读取默认用户目录的 DevToolsActivePort；两者均为 P0 验证项。
