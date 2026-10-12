# 注册（嵌入模式）

MCP 进程内直接跑 Runtime；路径必须绝对且指向构建产物：

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

# （可选）API 转发模式

先起长驻 API（见 [长驻 HTTP API 使用](api.md)），再给 MCP 进程加环境变量——多客户端共享同一次浏览器连接：

```json
{
  "env": {
    "JEV_BROWSER_API_URL": "http://127.0.0.1:3737",
    "JEV_BROWSER_API_TOKEN": "<token>"
  }
}
```

# 15 个工具与参数全表

描述末尾带风险标签 readonly/write/control；执行错误返回 `{error:{code,message}}` + `isError:true`；execute/run/act 阻塞到任务落定，上限 30 分钟：

| 工具 | 参数（粗体必填） | 说明 |
|---|---|---|
| `browser_doctor` | `connect?`（boolean） | 诊断；true=尝试接管【readonly】 |
| `browser_connect` | `url?`/`pageId?`（二选一）、**`allowedOrigins`**（string[]）、`modelOrigins?` | 建会话【control】 |
| `browser_pages` | **`sessionId`** | 列标签页【readonly】 |
| `browser_select_page` | **`sessionId`** **`pageId`** | 切页【control】 |
| `browser_snapshot` | **`sessionId`**、`forModel?`、`viewportOnly?`、`maxElements?`、`filter?`、`roles?` | 快照【readonly】。默认只采集**视口内**元素、上限 200；`filter` 按 name 子串收窄、`roles` 按角色收窄；`forModel` 只回 `rendered` 紧凑文本行 |
| `browser_execute` | **`sessionId`** **`steps`**（FlowStep[] 或简写字符串[]）、`values?`、`includeObservation?`、`followNewTab?`、`detectNewTabs?`、`observationOptions?` | 批量步骤【write】。普通模式默认观察并跟页；快速模式按需开启 |
| `browser_run` | **`sessionId`** **`goal`** **`successCriteria`**、`values?` | 自主任务【write】 |
| `browser_act` | **`sessionId`** **`step`**（对象或简写字符串）、`values?`、`includeObservation?`、`followNewTab?`、`detectNewTabs?`、`observationOptions?` | 单步动作【write】。后置处理选项同 execute |
| `browser_task_get` | **`taskId`** | 查询【readonly】 |
| `browser_task_cancel` | **`taskId`** **`requestId`**、`expectedRevision?` | 取消【control】 |
| `browser_task_resume` | **`taskId`** **`requestId`**、`expectedRevision?`、`rerunConfirmed?`、`allowReplan?` | 恢复【control】 |
| `browser_task_approve` | **`taskId`** **`grant`** | 审批【control】 |
| `browser_artifact_get` | **`taskId`** | 产物元信息【readonly】 |
| `browser_disconnect` | **`sessionId`**、`detachTask?` | 断开【control】 |
| `browser_judge` | **`sessionId`** **`question`** | 单问题语义判断【readonly】：把「当前页是否满足某条件」交给 Jev 打分（0~1）。**一句话顶一屏元素**——只需知道「有没有订单号/是否已登录」时，比读一整屏观察省一个量级的 token；需 origin ∈ `modelOrigins` |

# 一行式简写步骤（execute / act）

`steps` 里每一项可以是 FlowStep 对象，也可以是一行字符串——同样的动作，生成的 token 少一个量级。id 可省略，会自动补 `s1/s2/…`。

```text
<verb>:<参数>[ => <expect>[; <expect>]...]

定位器：role/<role>[/<name>]   label/<name>   testid/<id>   text/<文本>   css/<选择器>
末尾加 "!" = 精确匹配：「click:text/播放!」只匹配文本恰为「播放」的元素。
列表页常有同名节点（标题链接 / 同名容器 / hover 卡），非精确会点到不可点的容器上——实测踩过。
值分隔符是参数里最后一个 "="（CSS 选择器常含 "="）；值写成 $name 表示引用 values
```

| 写法 | 含义 |
|---|---|
| `navigate:https://example.com/page` | 导航 |
| `click:role/button/搜索` | 按 role+name 点击 |
| `fill:css/#kw=虎皮鹦鹉` | 填值（`fill:css/#pw=$password` → valuesRef） |
| `press:Enter` / `scroll:600` / `wait:2000` / `screenshot` / `evaluate:document.title` | 其余动作 |
| `click:text/更多 => url_contains:/list` | 追加后置条件 |
| `fill:css/#kw=虎皮鹦鹉 => value_equals:css/#kw=虎皮鹦鹉` | 用输入值断言结果（受控组件写不进去时会被抓住） |

`=>` 后可写多个，用 `;` 分隔：`url_contains` / `text_present` / `visible` / `hidden` / `not_visible` / `count_gte` / `value_equals` / `value_contains` / `var_equals` / `download_completed`。

**导航与写操作仍必须带后置条件**（这条约束没放松，只是写起来更短了）。

# 批量执行与快速模式

连接一次，后续任务复用同一 `sessionId`。已知步骤在一次 `browser_execute` 中批量执行；仅在需要重新判断页面或切换新页时结束当前批次。自动跟页发生在整个批次结束后，不在每个步骤之间，不能把「点开新页 + 操作新页」盲目塞进同一批。

普通模式保留原默认行为。固定流程可给 MCP 进程设置：

```json
{
  "env": { "JEV_BROWSER_MCP_FAST_MODE": "true" }
}
```

重启 MCP 后生效。快速模式下 execute/act 默认 `includeObservation:false`、`detectNewTabs:false`、`followNewTab:false`；跳过附加快照、前后标签页查询及新页轮询，但仍执行所有授权、审批、预算及后置条件检查。任务 envelope、错误、暂停原因仍完整返回。

无需修改进程配置，也可逐次使用快速路径：

```json
{
  "sessionId": "sXX",
  "steps": [
    "fill:css/#kw=redfish => value_equals:css/#kw=redfish",
    "click:role/button/搜索 => text_present:搜索结果"
  ],
  "includeObservation": false,
  "detectNewTabs": false
}
```

不知道页面结果或可能需要继续操作新页时，不应关闭相应功能。快速模式可以按次恢复 `includeObservation:true` 和 `followNewTab:true`（后者也恢复探测）；显式 `detectNewTabs:false` 始终优先，既不探测也不跟随。

execute/act 结果新增 `mcpMetrics`：`taskWaitMs`（提交至落定）、`pageTrackingMs`（前后查询、轮询及切页）、`observationMs`、`totalMs`。它是本次 MCP 调用的附加计时，不写进持久化任务 envelope；不包含 Agent 思考、MCP 进程启动和最终传输耗时。用它区分浏览器任务和适配器附加成本，不把模拟测试当真实网站提速倍数。

API 转发的短任务状态检查由固定 500ms 改为 100→200→400→500ms 退避，长任务保持最多每秒 2 次查询。首个状态请求立即发出；提交已返回终态／暂停时不再查询。嵌入模式仍使用进程内等待，不增加轮询。

# 自动后置观察（afterObservation）

`browser_execute` / `browser_act` 在普通模式默认附一份 `afterObservation`（视口内、上限 150）；快速模式默认不附。需要观察时传 `includeObservation:true`，并用 `observationOptions` 一次返回相关内容，无需再发一个 snapshot：

```json
{
  "sessionId": "sXX",
  "steps": ["click:role/button/搜索 => text_present:搜索结果"],
  "includeObservation": true,
  "detectNewTabs": false,
  "observationOptions": {
    "filter": "结果",
    "roles": ["link", "button"],
    "maxElements": 30,
    "viewportOnly": true
  }
}
```

`observationOptions` 支持 `forModel`、`viewportOnly`、`maxElements`（1–2000）、`filter`、`roles`。`forModel:true` 仍须 origin ∈ modelOrigins，不能借自动观察绕过外发许可。不需要观察时传 `includeObservation:false`；此时忽略观察选项，不采集页面。观察失败保持原语义：不覆盖任务结果，必要时单独 snapshot 排查。

```text
browser_execute { sessionId, steps: ["click:role/button/搜索 => url_contains:/search"] }
  → { ...envelope, afterObservation: { url, title, elements: [...], truncated } }
```

# 新标签页：openedPages / followNewTab

搜索结果、详情页的链接普遍是 `target=_blank`，点一下就多一个标签页。`browser_execute` / `browser_act` 会自动识别任务期间新开的页：

```text
browser_execute { sessionId, steps: ["click:role/button/登录"] }
  → { ...envelope, openedPages: [{pageId:"p2", url, title}], followedPageId: "p2",
      afterObservation: {...} }   ← 观察已经是在新页上取的
```

`followNewTab` 在普通模式默认 **true**（自动切到最新新页，并以 `followedPageId` 明示）。
传 `followNewTab:false` 仍做前后两次页列表查询，但只做一次结束探测、不轮询、不切页；晚出现的新页可能漏报。
传 `detectNewTabs:false` 才完全跳过页列表查询和新页跟随，适合确定在原页完成的批处理。快速模式默认关闭这三项，按次显式开启即可。

检测细节：浏览器处理 `target=_blank` 是**异步的**，新页出现晚于任务落定——实测点击 resolve 之后还要
**276~440ms** 才能在标签页列表里看到它，所以「任务一结束就查一次」可能漏报。启用跟页时，含 `click`、`press`、`evaluate`、`goal`（含 branch/forEach 内的步骤）的任务在最多 700ms 窗口内轮询，发现新页即返回；其他任务只查一次。
`followNewTab:false` 跳过等待但仍查一次；`detectNewTabs:false` 则连前后查询也省掉。前置查询失败时不跟页，避免把已有页误报为新页；附加探测失败不会改掉任务结果。

# Jev 优先：把「点哪」交给 Jev，而不是每次都让大模型看页面

两条路的成本差一个量级：

| 场景 | 用哪个 | 成本 |
|---|---|---|
| 你已经知道点什么（选择器/文本明确） | `click:<loc>` 等确定性动作 | **0 次模型调用**，约 100ms |
| 你只知道「要达成什么」，不知道点哪 | `goal:<自然语言目标>`（Jev 局部循环） | 每轮 1 次 Jev 请求；**全程仍只占 1 次 MCP 往返** |

```text
browser_execute { sessionId, steps: ["goal:打开搜索结果里的第二个视频 => url_contains:/video/"] }
```

goal 步骤在服务端自己循环：观察 → Jev 判断（点哪/填哪）→ 执行 → 再观察，直到达成或停下。
**中间那些页面观察不会进入调用方的上下文**——这正是它比「snapshot → 决定 → click → 再看」快得多的原因。

前提与边界：

- 需要该页 origin ∈ `modelOrigins`（Jev 是外部服务，页面候选会发出去）
- **Jev 把握不足时会停下，并把候选交回给你**（阈值 `jev.targetConfidenceAt`，默认 0.6；用的是服务端返回的
  `confidence` 校准值，缺失时退回该选项的原始概率）。这就是「Jev 优先、拿不准再上大模型」的接入点：
  暂停信息里带前 5 个候选，你直接改用确定性 `click` 即可——而不是让 Jev 赌一次随机点击
- **后置条件在每次动作后立即校验**：一旦成立就收工（记为 `deterministic`），不再多问一轮 Jev。
  实测踩过：动作其实已经完成（视频页已打开），循环却又跑一轮，那一轮 Jev 把握不足 → 任务暂停在
  `ambiguous`，用户看到的是「明明成功了却报失败」
- 循环检测（连续 3 次相同动作且页面无变化）也会停下，不空转
- 发给 Jev 的候选**裁剪到 80 个**并按相关性/可见性排序。这不是省钱的小事：实测同一目标下，
  整页 166 个候选（含导航/页脚/广告）会让它判「已完成」而**什么都不做**；砍到 20 个干净候选则 3/3 选对

## Jev 端点、代理与地区可用性

**先看代理，再看地区。** 实测踩到过：浏览器能正常访问 Jev，工具却报
`451 Typesafe is not available in your region`。真因不是地区——是**本机开了系统代理，而 Node 不读 Windows
系统代理**（只认环境变量）。同一个请求：

| 路径 | 结果 |
|---|---|
| 浏览器 / curl -x 代理 | 通（422 业务校验错误 = 已到达服务） |
| 直连（`curl` 不带 -x） | **451** |

修法：让进程带上代理环境变量。`NODE_USE_ENV_PROXY` **只在进程启动时读取**（脚本里运行时赋值无效）：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"     # 换成你的端口
$env:NODE_USE_ENV_PROXY = "1"
$env:NO_PROXY = "127.0.0.1,localhost,::1"       # 回环必须直连：CDP 与本地 API 走 127.0.0.1
```

**经仓库启动器拉起 MCP 时无需手动设置**：`bin/tool-launcher.js` 会读注册表里的系统代理并注入子进程
（设 `JEV_BROWSER_NO_SYSTEM_PROXY=1` 可关闭）。启动时 stderr 会打一行确认，便于核对：

```
[jev-browser-mcp] 外呼代理: HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost,::1
```

直接跑 CLI / HTTP API 时（不经启动器）需自行设置上述变量。

确属地区限制时，服务端会返回 `451 Typesafe is not available in your region`（工具映射成 `JEV_UNAVAILABLE`
并给出指引）。端点可覆盖，**无需改代码**：

```powershell
# 本工具的一等配置（会写进 config.json，doctor 里能直接看到）
$env:JEV_BROWSER_JEV_BASE_URL = "https://<可达的代理或自建端点>"
# 或直接用 SDK 认的环境变量（等价）
$env:TYPESAFE_BASE_URL = "https://<可达的代理或自建端点>"
```

`doctor` 会打印当前生效的端点（`jevEndpoint` 一行），排查 451 不用猜。

# 用一句话代替读一屏：browser_judge

验证类需求（「下单成功了吗」「页面上有没有错误提示」）不必回传整屏元素让大模型自己看解答：

```text
browser_judge { sessionId, question: "页面上是否出现了订单号？" }
  → { p: 0.93, url: "https://shop.example.com/done", model: "jev-1.13.0" }
```

一次 Jev 请求 ≈ 300ms，只发视口内前 60 个候选，返回几十字节。需要 origin ∈ `modelOrigins`（页面候选会发给 Jev）。

# 断言会重试（别再写「等一下」的步骤）

页面类后置条件（`url_contains` / `text_present` / `not_visible` / `count_gte` / `value_equals` / `value_contains`）默认在 **5 秒窗口内轮询**，`runtime.expectRetryMs` 可调（`JEV_BROWSER_EXPECT_RETRY_MS`，0 = 不重试）。所以**不需要**在点击后塞 `wait` 步骤去等效果落地——把该有的后置条件写上就行。

# Agent 典型调用序列

> 选入口：能写清步骤就用 `browser_execute`（零模型调用，毫秒级）；只有「不知道该怎么点」时才用 `browser_run`
> ——它每次规划要调一次云 planner、每轮判断调一次 Jev，是秒级且要烧 token。

```text
browser_doctor {}                                          → 自检
browser_connect { url, allowedOrigins: ["https://..."] }   → 建会话（allowedOrigins 必填！）
browser_snapshot { sessionId }                             → 只读观察（默认视口内、≤200）
browser_execute { sessionId, steps: ["click:role/button/登录"] }  → 动作 + 自动观察
browser_artifact_get { taskId }                            → 列产物
browser_disconnect { sessionId }                           → 收尾（暂停任务需 detachTask:true）
```

# MCP 进程环境变量

所有 `JEV_BROWSER_*` 覆盖均生效；转发模式加 `JEV_BROWSER_API_URL/TOKEN`。`JEV_BROWSER_MCP_FAST_MODE=true`（或 `1`）开启 MCP 的按需后置处理，未设置／false 保持兼容；只影响 execute/act，不跳过 run 的内部规划或验证。

# 仓库启动器（统一 MCP 入口）

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list                # 应列出 jev-browser
node bin/tool-launcher.js build jev-browser   # 只装依赖并构建
node bin/tool-launcher.js jev-browser         # 以 MCP stdio 拉起（缺 dist 自动构建）
```
