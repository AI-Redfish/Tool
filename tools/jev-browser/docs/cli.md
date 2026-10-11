## **参数书写规则**

- 取值参数两种写法等价：`--origin https://a.com` 与 `--origin=https://a.com`；值本身以 `--` 开头时必须用等号形式。
- 可重复参数（`--origin`、`--model-origin`）传多次会自动累积为数组。
- 旗标（布尔开关，后面不跟值）：`--json`、`--connect`、`--for-model`、`--detach-task`、`--rerun-confirm`、`--replan`、`--no-save`。
- JSON 参数（`--file`/`--steps`/`--values`/`--step`）三种等价写法：内联 JSON 字符串、已存在的文件路径、`-`（从 stdin 读）。



## 全局参数

所有子命令可用。

### **`--config <path>`** 

显式指定配置文件（文件必须存在且合法）；优先级：`--config` > 环境变量 `JEV_BROWSER_CONFIG` > 用户配置目录。

```powershell
node cli/dist/index.js doctor --config examples/config.attach-chrome.json
```



### **`--json`**

stdout 输出完整 envelope / 结构化 JSON（供程序消费）；不带时任务类命令只在 stderr 打印人读摘要，stdout 保持纯净便于管道。

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com" --json | jq ".status"
```



### **`--api <url>`**

API 转发模式：命令转发到长驻 API（如 `http://127.0.0.1:3737`），Bearer token 取环境变量 `JEV_BROWSER_API_TOKEN`；服务端启动与路由总表见 [长驻 HTTP API 使用](api.md)。

该模式下 execute/run/act/snapshot 必须先 `connect` 拿到sessionId，后续操作传 `--session`。

```powershell
node cli/dist/index.js connect    --api http://127.0.0.1:3737 --url "..." --origin
 "..."   # ① 建会话，返回 sessionId
   node cli/dist/index.js snapshot   --api http://127.0.0.1:3737 --session sXX --json
             # ② 观察
   node cli/dist/index.js execute    --api http://127.0.0.1:3737 --session sXX --file
 bili.flow.json  # ③ 操作
   node cli/dist/index.js pages      --api http://127.0.0.1:3737 --session sXX
 # ④ 看新开的标签页
   node cli/dist/index.js disconnect --api http://127.0.0.1:3737 --session sXX
 # ⑤ 结束
```





### **`--help`**

向 stderr 打印命令速览，退出码 0；等价于不带参数运行或 `help` 子命令（注意：`-h` 单横线不是本 CLI 的旗标）。

```powershell
node cli/dist/index.js execute --help
```



## 环境与诊断

### help

帮助速览

无参数。向 stderr 打印全部命令与参数速览，退出码 0。三种等价触发方式：

```powershell
node cli/dist/index.js
node cli/dist/index.js help
node cli/dist/index.js execute --help
```



### doctor

 环境与配置诊断

静态检查 Node 版本、数据目录、配置文件、环境变量覆盖、凭据与浏览器能力，逐项输出 `[OK]/[FAIL]`；不带 `--connect` 时退出码 0。

```powershell
node cli/dist/index.js doctor
```

**`--connect`** —— 在静态检查之上额外尝试真实接管浏览器（attach），输出 `[connect] OK/FAIL: ...`；失败退出码 4。

```powershell
node cli/dist/index.js doctor --connect
```



### chrome-debug 

 chrome-debug 是一个手动预热/预配置命令：确保「固定端口的专用调试 Chrome」在运行，并把
 连接地址写进配置。它做三件事（幂等，跑多少次都安全）：

 它做的三件事

 ```
   node cli/dist/index.js chrome-debug
           │
           ├─ ① 探测 127.0.0.1:9223 ──→ 已有调试 Chrome 在跑？──→ 是：直接复用，什么都
 不做（秒回）
           │                                    │否
           ├─ ② 拉起专用 Chrome 实例
           │     chrome --remote-debugging-port=9223
           │            --user-data-dir=C:\Users\<你
 >\AppData\Local\AI-Redfish\jev-browser\chrome-debug-profile
           │     （detached 独立进程：CLI 退出后浏览器继续活着）
           │
           └─ ③ 把端点 http://127.0.0.1:9223 写入用户配置 config.json
                 → 之后所有 CLI/MCP/API 命令自动知道连哪，免设环境变量
 ```

案例

```powershell
node cli/dist/index.js chrome-debug
```

**`--port <n>`** —— 固定调试端口（默认 9223）；先探测该端口，已有调试 Chrome 在跑就复用（不重复启动）。若端口被**无 CDP 能力的进程**占用（如日常 Chrome，`/json/version` 404），秒级报 `BROWSER_BUSY` 并指出占用者 PID 与命令行（不会拉起后白等超时），换端口重试即可。

```powershell
node cli/dist/index.js chrome-debug --port 9223
```

**`--user-data-dir <目录>`** —— 调试专用 profile 目录，不要用日常默认目录。

```powershell
node cli/dist/index.js chrome-debug --port 9223 --user-data-dir "D:\chrome-debug-9223"
```

**`--executable <路径>`** —— Chrome 可执行文件路径（默认按平台自动探测）；也可用环境变量 `JEV_BROWSER_CHROME_EXECUTABLE`。

```powershell
node cli/dist/index.js chrome-debug --executable "C:\Users\me\AppData\Local\Google\Chrome\Application\chrome.exe"
```

**`--wait-ms <n>`** —— 启动后等待 CDP 端点就绪的毫秒数（默认 15000）。

```powershell
node cli/dist/index.js chrome-debug --wait-ms 30000
```

**`--no-save`** —— 跳过「把 attach 端点写入用户配置」（默认写入，后续命令免设环境变量）。

```powershell
node cli/dist/index.js chrome-debug --no-save
```



## 一次性执行

### execute

确定性步骤（零模型调用）。

执行 FlowStep 数组（action/assert/extract/branch/forEach），不调用任何模型。

任务落定后按状态退出：0 done / 3 paused / 4 failed / 130 cancelled。



**`--file <path>`** —— FlowStep 数组文件。自动拆包取 steps。

与 `--steps` 二选一，同时给时 `--file` 优先。

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```



**`--steps <json>`** —— 直接给 FlowStep 数组。

数组里每一项可以是 FlowStep 对象，也可以是一行**简写字符串**（更省 token，id 可省略，自动补 `s1/s2/…`）：

```text
<verb>:<参数>[ => <expect>[; <expect>]...]

定位器：role/<role>[/<name>]   label/<name>   testid/<id>   text/<文本>   css/<选择器>
末尾加 "!" = 精确匹配（如 "click:text/播放!"）；列表页同名元素多时用它，否则会点到不可点的容器上
值分隔符是参数里最后一个 "="（CSS 选择器常含 "="）；值写成 $name 表示引用 values
```

```powershell
# 同上那串 JSON 的简写等价写法
node cli/dist/index.js execute --session sXX --values '{"kw":"redfish"}' --steps '[
  "navigate:https://example.com/search => url_contains:/search",
  "fill:role/textbox/关键词=$kw => value_equals:role/textbox/关键词=redfish",
  "click:role/button/搜索 => text_present:条结果",
  "screenshot"
]'
```

`=>` 后可写多个后置条件（用 `;` 分隔）：`url_contains` / `text_present` / `visible` / `hidden` / `not_visible` / `count_gte` / `value_equals` / `value_contains` / `var_equals` / `download_completed`。

其中 `value_equals` / `value_contains` 读的是表单元素当前值——`fill` 之前没有任何办法验证输入是否真的写进去了（受控组件会静默失败），这两个断言补上了这个缺口。`not_visible` 用于验证删除/关闭类操作已生效。

**导航与写操作仍必须带后置条件**，简写只是让它写起来更短。

```powershell
node cli/dist/index.js execute  --url "https://example.com"  --origin "https://example.com"  --steps '[{\"id\":\"s1\",\"kind\":\"action\",\"action\":\"navigate\",\"value\":\"https://example.com/search\",\"expect\":[{\"kind\":\"url_contains\",\"value\":\"/search\"}]},{\"id\":\"s2\",\"kind\":\"action\",\"action\":\"fill\",\"target\":{\"by\":\"role\",\"role\":\"textbox\",\"name\":\"关键词\"},\"valuesRef\":\"kw\",\"expect\":[{\"kind\":\"visible\",\"target\":{\"by\":\"role\",\"role\":\"textbox\",\"name\":\"关键词\"}}]},{\"id\":\"s3\",\"kind\":\"action\",\"action\":\"click\",\"target\":{\"by\":\"role\",\"role\":\"button\",\"name\":\"搜索\"},\"expect\":[{\"kind\":\"text_present\",\"value\":\"条结果\"}]},{\"id\":\"s4\",\"kind\":\"extract\",\"target\":{\"by\":\"css\",\"selector\":\".result-list\"},\"fields\":[\"count\"],\"saveAs\":\"resultCount\"},{\"id\":\"s5\",\"kind\":\"assert\",\"expect\":[{\"kind\":\"count_gte\",\"target\":{\"by\":\"css\",\"selector\":\".result-item\"},\"value\":1}]}]'  --values '{\"kw\": \"redfish\"}'  --json
```



**执行目标**

--url,--page,uusession <id>

三种参数是 execute（以及 run/snapshot）指定"在哪个页面上跑”的三种方式，核心区别在会话的生命周期和标签页来源：

 对比总览

|                   | `--url`                     | `--page`                 | `--session`                |
| ----------------- | --------------------------- | ------------------------ | -------------------------- |
| 会话来源          | 现场新建（一次性）          | 现场新建（一次性）       | 复用 `connect` 建好        |
| 的长会话          |                             |                          |                            |
| 标签页            | **新开**一个标签页          | **附加**到已打开的标签页 | 会话当时绑定的             |
| 标签页            |                             |                          |                            |
| 命令结束后        | 自动 `disconnect` + `close` | 同左                     | **保持连接**，供后续命     |
| 令继续使用        |                             |                          |                            |
| 需要配 `--origin` | ✅ 必须传                    | ✅ 必须传                 | ❌ 不用，`connect` 时已设定 |




**`--url <url>`** —— 目标页三选一（`--url`/`--page`/`--session`）：一次性会话，自动新开页、跑完自动断开（需配 `--origin`）。

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```

**`--page <id>`** —— 目标页三选一：绑定既有标签页的一次性会话（pageId 来自 `pages` 输出，如 `p0`）。

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --page p0 --origin "https://example.com"
```

**`--session <id>`** —— 目标页三选一：复用长会话（跨命令场景，先见 `connect`）。不需要--origin参数。

```powershell
node cli/dist/index.js execute --file bili-open4.flow.json --session sXX
```



**安源域**

| 对比项   | `--origin`（动作域）                                  | `--model-origin`（外发域）                        |
| -------- | ----------------------------------------------------- | ------------------------------------------------- |
| 管什么   | 会话能在哪些 origin 上执行操作（导航/点击/填表/读取） | 允许把哪些 origin 的页面摘要发给云模型（planner） |
| 防什么   | 机器人越权跑到别的网站乱操作                          | 页面内容（可能含隐私）泄露给 AI服务               |
| 边界方向 | 工具 → 网站（控制面）                                 | 网站 → 云模型（数据面）                           |
| 默认值   | 空 = 全部禁止                                         | 空 = 全部禁止                                     |
| 违规后果 | 首个域外动作直接报 `ORIGIN_NOT_ALLOWED`               | 暂停而非失败                                      |



**`--origin <o>`** —— 会话授权域（可重复传；一次性会话必填*）。默认空 = 不许可任何网站，首个域外动作报 `ORIGIN_NOT_ALLOWED`（*CLI 不强制校验，MCP 侧为硬必填）。搜索页/详情页常是两个域，都要声明。

```powershell
node cli/dist/index.js execute --file search.flow.json --url "https://www.bilibili.com" --origin "https://www.bilibili.com" --origin "https://search.bilibili.com"
```



**`--model-origin <o>`** —— 允许页面摘要外发云模型的域（可重复，必须 ⊆ origin）；默认空 = 禁止外发。flow 含 goal 语义步骤时必须声明。

```powershell
node cli/dist/index.js execute --file with-goal.flow.json --url "https://example.com" --origin "https://example.com" --model-origin "https://example.com"
```





**`--idempotency-key <k>`** —— 幂等键：同 key + 同请求体重放返回原任务；同 key + 不同请求体报 `IDEMPOTENCY_CONFLICT`（防网络超时重发重复下单）。

```powershell
node cli/dist/index.js execute --file order.flow.json --session sXX --idempotency-key order-20260101-001
```



**`--values <json>`** —— 变量初值（标量字典），供步骤 `valuesRef` 引用。

```powershell
node cli/dist/index.js execute --file search.flow.json --url "https://www.bilibili.com" --origin "https://www.bilibili.com" --origin "https://search.bilibili.com" --values '{"startUrl":"https://www.bilibili.com","keyword":"虎皮鹦鹉"}'
```





### judge

单问题语义判断：把「当前页是否满足某条件」交给 Jev 打分（0~1）。用一句话代替读一整屏元素。

```powershell
node cli/dist/index.js judge --session sXX --question "页面上是否出现了订单号？"
```

**`--session <id>` / `--question <文本>`** —— 均必填；origin 必须在 `modelOrigins` 内（页面候选会发给 Jev）。



### snapshot 

功能和execute的区别如下：

| 对比项       | `snapshot`                                                   | `execute`                                               |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------- |
| 本质         | 只读观察当前页面（风险级 `readonly`）                        | 执行确定性步骤序列（含写操作）                          |
| 输入         | 只有目标页参数 + `--for-model` / `--viewport-only` / `--max-elements` | 必须给 `steps`（`--file` /`--steps`）+ `--values`       |
| 对页面的影响 | 零副作用：不点击、不导航、不填表                             | 会改变页面状态：navigate / click / fill / upload…       |
| 输出         | `PageObservation`：snapshotId、url、title、元素清单（role/name，脱敏，默认上限 400，超出标 `truncated`） | `TaskEnvelope`：status、stepResults、artifacts、metrics |
| 是否调模型   | 不调；`--for-model` 只回 `rendered` 紧凑文本行（需 origin ∈ `modelOrigins`） | 全程不调模型（区别于 `run`）                            |
| 失败语义     | 采集失败一次性报错（如 `CAPABILITY_UNSUPPORTED`）            | 逐步执行，可暂停（审批 / needs_input）再 resume         |
| 退出码       | 正常输出后直接 0                                             | 0 done / 2 参数错 / 3 paused / 4 failed                 |

**`--viewport-only`** —— 只采集与视口相交的元素。长页面里页脚、导航、相关推荐往往占掉大半元素，按视口过滤能显著减小返回体积。MCP 侧默认开启，CLI 默认关闭（保持脚本行为不变）。

**`--max-elements <n>`** —— 元素上限（默认 400，硬上限 2000）。

**`--filter <子串>`** —— 只保留 name 含该子串的元素（大小写不敏感）。「我要找那个东西」时用它，比拉整页小一个量级。

**`--roles <a,b>`** —— 只保留这些 role 的元素，例如 `--roles button,textbox`。

**`--for-model`** —— 只返回 `rendered` 紧凑文本行（`[i] role "name"`），不回元素对象数组；同时要求 origin ∈ `modelOrigins`。

元素清单**不含冗余字段**：`text` 与 `name` 同源，序列化时会被剥离；每步证据里的超长 URL（带跟踪参数）也会收敛为 `origin+path`。

案例：

```
# 1. 侦察：看页面上有什么元素
node cli/dist/index.js snapshot --url "https://www.bilibili.com" --origin "https://www.bilibili.com"

# 2. 根据输出写 flow.json（比如定位到 role=textbox name=搜索）
# 3. 执行
node cli/dist/index.js execute --file search.flow.json --url "https://www.bilibili.com" --origin     "https://www.bilibili.com"
```



### run 

自主任务（规划 + 执行）。

run 和 execute 的本质区别一句话：execute 是你写死步骤它照做；run 是你给目标 ，云模型现场规划步骤再执行，做完还有“语义验收”把

关。



 run 的执行流程

 ```
   --goal + --success
      → ① 盲规划：planner 只看 goal/验收文本/URL，产出 FlowStep[]
      → ② 逐步执行（同 execute；若含 goal 步骤 → 此处才有"观察页面→发LLM模型"生成FlowStep[]，循环执行。
  ）
      → ③ 任务级验收：Jev 只拿脱敏URL+done步骤id+验收文本打分
           p ≥ doneAt → done (semantic)
           p < doneAt → likely_done 暂停
                ├ task resume --rerun-confirm   人工拍板
                └ task resume --replan          重规划后缀（输入多给completedStepIds + pausedReason，依然没有整页快照）
 ```



**前置**

一次性配置；规划器与 Jev 是两份独立凭据：

```powershell
$env:JEV_BROWSER_PLANNER_ENABLED = "true"
$env:JEV_BROWSER_PLANNER_BASE_URL = "https://api.deepseek.com/v1"
$env:JEV_BROWSER_PLANNER_MODEL = "deepseek-chat"
$env:JEV_BROWSER_PLANNER_API_KEY = "<规划模型 key>"
$env:TYPESAFE_API_KEY = "<Jev key>"
```



**特有参数**

| 参数                                  | 说明                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| `--goal <文本>`                       | **必填**，自然语言目标                                   |
| `--success <文本>`                    | **必填**，任务级验收条件（防规划器自证成功，代码硬校验） |
| `--model-origin <o>`                  | 声明允许把哪个域的页面摘要发给云模型。                   |
| `--replan`（`task resume` 时）        |                                                          |
| `--rerun-confirm`（`task resume` 时） |                                                          |



#### **--replan**

 你用 run 时，系统内部发生的事可以类比为 GPS 导航：

 ```
   你说的                        系统做的
   ─────────────────────────────────────────────────────
   --goal "搜索并打开第一个视频"   → 规划器画出一条路线（一串步骤）
   --success "播放器出现"         → 一句"怎么算到了"
 ```

 假设规划器画出的路线是 5 步：

 ```
   计划：[s1 打开搜索页] [s2 填关键词] [s3 点搜索] [s4 点第一个结果] [s5 断言播放器]
          └────────── 已走 ──────────┘└──────── 未走（后缀）────────┘
                                      ↑ 游标 cursor 停在这里
 ```

 中途抛锚：任务为什么会暂停

 执行到 s4 卡住了——比如页面弹了个登录框，或者按钮定位器过时了。任务不是失败，而是暂停（paused），整个状态
 被完整冻结：

 - 已完成的 s1~s3（连同它们造成的页面效果）原样保留
 - 游标 cursor 停在 3，后缀 [s4, s5] 原封不动存着
 - 任务记录里存着暂停原因（pauseReason）

 现在轮到你来决策：这条路线的后半段，还作数吗？这就是 task resume 系列参数的由来——三种走法：

 三种走法（这里是核心）

 ```
                           暂停中（s1✓ s2✓ s3✓ | s4 s5 未走）
                                         │
           ┌─────────────────────────────┼─────────────────────────────┐
           ▼                             ▼                             ▼
      resume（不带参数）            --rerun-confirm                  --replan
           │                             │                             │
      "障碍没了，原计划继续"         "其实已经到了"                 "后半段路作废，重新规划"
           │                             │                             │
      适合：你手动关掉了弹窗，        适合：页面其实已经到达目的地，    适合：原计划的后半段
      s4 s5 再试一遍就能过           只是验收打分没过 → 人工签收       确实走不通（选择器过时、
                                                                     缺信息）→ 模型重想
 ```

 --replan 就是第三种走法。

 --replan 具体做了什么

 它让规划器重新画后半段的路，注意三个细节：

 ```
   重新规划时模型能看到什么：
     目标 + 验收条件 + 当前 URL + 已完成步骤 id（s1,s2,s3）+ 暂停原因
     （依然看不到页面内容——和初始规划一样是"盲"的）

   重新规划后怎么拼：
     [s1 s2 s3]  +  [s4' s5']     ← 新后缀可能是完全不同的步骤
      原样保留        模型新生成      （已花的功夫不浪费，副作用不重放）

   然后呢：
     接着跑新后缀 → 跑完照旧过 Jev 验收 → 过了才 done
     （重新规划 ≠ 直接算成功，验收关照过不误）
 ```

 为什么要有预算闸门

 重规划要烧一次模型调用，而且可能“规划→跑→又暂停→再规划”无限打转。所以：

 - maxReplans（默认 3 次）：最多改道 3 次
 - maxPlannerRequests（默认 8 次）：初始规划 + 所有重规划加起来最多 8 次
 - 超了直接 BUDGET_EXCEEDED，逼你人工介入

 这也是为什么 --replan 是每次 resume 显式声明才触发——系统绝不自作主张替你改道烧钱。



**场景案例**

**第 1 幕：发起任务**

```powershell
node cli/dist/index.js run `
  --goal "打开博客首页，抓取最近 3 篇文章的标题" `
  --success "提取到 3 个标题并存入变量" `
  --url "https://blog.example.com" --origin "https://blog.example.com" `
  --model-origin "https://blog.example.com" --json
```

规划器画出路线：

```
[s1 打开首页] [s2 extract 文章链接列表] [s3 点"下一页"翻页] [s4 extract 标题] [s5 断言 3 条]
```

**第 2 幕：卡死在 s3**

这个博客的文章列表其实是**滚动自动加载**的，根本没有"下一页"按钮。s3 点了三次"下一页"，页面纹丝不动，goal 执行器判定死循环：

```
PauseSignal('ambiguous', '连续 3 次相同动作且页面无变化，判定为循环')
```

任务暂停。看现场：

```powershell
node cli/dist/index.js task get t_xyz789
```

```json
{
  "taskId": "t_xyz789",
  "status": "paused",
  "pauseReason": "ambiguous",
  "metrics": { "actions": 6, "plannerRequests": 1 },
  "stepResults": [
    { "id": "s1", "status": "done" },
    { "id": "s2", "status": "done" },
    { "id": "s3", "status": "paused" }
  ]
}
```

**第 3 幕：两种徒劳的走法**

```powershell
# 走法 1：直接续跑 —— s3 还是点"下一页"，还是死循环，白跑
node cli/dist/index.js task resume t_xyz789 --request-id r1

# 走法 2：--rerun-confirm —— 只是"再点一次下一页"，循环依旧，治标不治本
node cli/dist/index.js task resume t_xyz789 --rerun-confirm --request-id r2
```

**问题不在"这一步没跑好"，而在"这一步本身就不该这么走"**——原计划的后缀 `[s3 翻页] [s4] [s5]` 整体已经不适用了。这才是 `--replan` 登场的时机。

**第 4 幕：--replan 改道**

```powershell
node cli/dist/index.js task resume t_xyz789 --replan --request-id r3
```

这一下，系统把任务状态打包喂给规划器：

```json
{
  "goal": "打开博客首页，抓取最近 3 篇文章的标题",
  "successCriteria": "提取到 3 个标题并存入变量",
  "currentUrl": "https://blog.example.com",
  "completedStepIds": ["s1", "s2"],
  "pausedReason": "ambiguous"
}
```

规划器换了个思路，产出**新后缀**（不再翻页，改用滚动加载）：

```
原计划：[s1 ✓] [s2 ✓] [s3 点下一页] [s4 extract] [s5 断言]
                        └──── 作废 ────┘
拼 接： [s1 ✓] [s2 ✓] [s3' evaluate 滚动加载脚本] [s4' extract 标题] [s5' 断言 3 条]
        └── 已完成的副作用原样保留 ──┘  └──────── 新后缀 ────────┘
```

**第 5 幕：跑完收工**

```
→ s3' 滚动加载出文章 → s4' 提取到 3 个标题 → s5' 断言通过
→ Jev 任务级验收 p=0.91 ≥ 0.8 → status: done
```

最终 envelope 里会留下改道痕迹：

```json
"metrics": { "actions": 9, "plannerRequests": 2, "replans": 1 }
```

**边界情况（顺手记住）**

```powershell
# 改道不是无限的：maxReplans 默认 3 次，用完再试 →
[jev-browser-cli] BUDGET_EXCEEDED: 重规划次数超过预算 3

# 用错了暂停类型也不行：likely_done 的任务不能用 --replan →
[jev-browser-cli] INVALID_INPUT: allowReplan 仅适用于 ambiguous/needs_input 暂停（当前 likely_done）
```

**复盘对比**

| | `--rerun-confirm`（购物下单案例） | `--replan`（本案例） |
| --- | --- | --- |
| 病因 | 结果未知（订单提交没？） | **方案本身错了**（翻页 vs 滚动加载） |
| 药方 | 人核实后放行，**原样重跑当前步** | 模型**换思路重写后缀**，已完成部分保留 |
| 烧钱 | 0 次模型调用 | 每次消耗 1 个 plannerRequests |
| 上限 | 无次数限制 | `maxReplans`=3 |

一句话：**`--rerun-confirm` 是"路没走完，接着走"；`--replan` 是"这条路不通，掉头重规划剩下的路——但已走过的里程不作废"。**



#### **--rerun-confirm**  

 案例：让 AI 在购物站下单

第 1 幕：发起任务

 ```powershell
   node cli/dist/index.js run `
     --goal "搜索《三体》实体书，加入购物车并提交订单" `
     --success "出现订单确认页，且包含订单号" `
     --url "https://shop.example.com" --origin "https://shop.example.com" `
     --model-origin "https://shop.example.com" --json
 ```

 规划器画出路线，开始执行：

 ```
   [s1 搜索三体] → [s2 点加入购物车] → [s3 点结算] → [s4 填地址] → [s5 点提交订单] → [s6 断言订单号]
 ```

第 2 幕：出事的那个瞬间

 s1~s4 一路顺利。执行 s5（点击“提交订单”） 时——

 点击请求刚发出去，浏览器调试连接断了（Chrome 更新重启/网络抖动）。

 现在系统面临一个它无法回答的问题：

 │ 这个点击，到底生效了没有？
 │ - 订单可能已经创建了 ✅
 │ - 也可能请求根本没到服务器 ❌
 │
 │ 连接断了，没有证据，无法证明。

第 3 幕：任务冻结，浏览器隔离

 任务暂停，你查一下状态：

 ```powershell
   node cli/dist/index.js task get t_abc123
 ```

 ```json
   {
     "taskId": "t_abc123",
     "status": "paused",
     "pauseReason": "interrupted",
     "stepResults": [
       { "id": "s1", "status": "done" },
       { "id": "s2", "status": "done" },
       { "id": "s3", "status": "done" },
       { "id": "s4", "status": "done" },
       { "id": "s5", "status": "paused", "error": { "code": "ACTION_OUTCOME_UNKNOWN" } }
     ]
   }
 ```

 注意 s5 的错误码：ACTION_OUTCOME_UNKNOWN——动作结果未知。同时系统给这个浏览器 profile 上了隔离：其他任务
 不许来碰这个“状态不明的浏览器”。

第 4 幕：你直接恢复，被拒绝

 ```powershell
   node cli/dist/index.js task resume t_abc123
 ```

 ```
   [jev-browser-cli] TASK_NOT_RESUMABLE: 该暂停涉及未证实结果或人工核验，需要显式 rerunConfirmed=true
 ```

 系统的话翻译过来就是：“s5 可能已经执行过了，我现在重跑它可能会重复下单。我不会赌，你先去搞清楚。”

第 5 幕：这就是设计目的——逼你先核实

 你现在必须做一件系统做不了的事：去现实世界里查证。

 打开浏览器看页面？查邮箱有没有订单确认邮件？登商家后台看订单列表？

 分支 A：查证结果——订单没建成（页面还停在结算页，没有确认邮件）

 好，重跑 s5 没有风险。签字：

 ```powershell
   node cli/dist/index.js task resume t_abc123 --rerun-confirm --request-id r1
 ```

 ```
   任务恢复 → 重新执行 s5 → 点击提交订单 → 订单创建
   → s6 断言通过 → Jev 验收 p=0.93 ≥ 0.8
   → status: done ✓
 ```

 同时浏览器隔离解除，其他任务可以正常使用它了。

 分支 B：查证结果——订单其实建成了（收到了确认邮件！）

 这时你绝不能带 --rerun-confirm 恢复——重跑 s5 就是第二笔订单，扣两次款。正确动作是取消任务、人工收尾：

 ```powershell
   node cli/dist/index.js task cancel t_abc123 --request-id r2
 ```

 --rerun-confirm 的全部意义就一句话：系统拒绝在事实不清时自动重放，把“重复执行会不会出事”这个判断，强制交
 还给掌握现实信息的人。



## 长会话交互

一次性会话「跑完即断」；要在同一页面上多轮交互（观察 → 操作 → 再观察），先 `connect` 建会话，后续命令都传 `--session`：

```powershell
node cli/dist/index.js snapshot --session sXX                               # 观察当前绑定页
node cli/dist/index.js execute --session sXX --file bili-open4.flow.json    # 在会话上跑确定性步骤
node cli/dist/index.js run --session sXX --goal "..." --success "..."       # 在会话上跑自主任务
```

### connect —— 建会话

**`--url <url>`** —— 会话目标二选一（`--url`/`--page`）：新开标签页。stdout 打印会话 JSON（取 `sessionId`）。

```powershell
node cli/dist/index.js connect --url "https://www.bilibili.com" --origin "https://www.bilibili.com" --origin "https://search.bilibili.com"
```

**`--page <id>`** —— 会话目标二选一：绑定既有标签页（id 来自 `pages` 输出或 `awaiting_page` 候选清单）。

```powershell
node cli/dist/index.js connect --page p0 --origin "https://example.com"
```

**`--origin <o>`** —— 建议必填*的会话授权域（可重复）；默认空 = 不许可任何网站。目标页不唯一时返回 `awaiting_page` + 候选清单，按清单改用 `--page` 重试。

```powershell
node cli/dist/index.js connect --url "https://example.com" --origin "https://example.com"
```

**`--model-origin <o>`** —— 允许外发云模型的域（⊆ origin）；run / goal / `--for-model` 需要。

```powershell
node cli/dist/index.js connect --url "https://example.com" --origin "https://example.com" --model-origin "https://example.com"
```

### pages —— 列标签页

**`--session <id>`** —— 会话 id（必填）。列出会话可见标签页（按授权域过滤、URL 脱敏）；典型用途：找 `target=_blank` 新开页的 pageId。

```powershell
node cli/dist/index.js pages --session sXX
```

### select-page —— 切换绑定页

**`--session <id>`** —— 会话 id（必填）。

```powershell
node cli/dist/index.js select-page --session sXX --page p2
```

**`--page <id>`** —— 要切换到的标签页 id（必填，来自 `pages` 输出）。

```powershell
node cli/dist/index.js select-page --session sXX --page p2
```

### act —— 单步动作

在既有会话上执行一个动作并等待任务落定；适合「snapshot 观察 → act 操作」交互循环。

**`--session <id>`** —— 长会话 id（必填；无一次性形态，必须先 `connect`）。

```powershell
node cli/dist/index.js act --session sXX --step click.step.json
```

**`--step <json>`** —— 单个 ActionStep（必填；FlowStep 结构与 LocatorSpec 白名单见 [技术设计 §8.1](../DESIGN.md)）；三种写法：内联 JSON / 文件路径 / `-` stdin。

```powershell
node cli/dist/index.js act --session sXX --step '{"id":"click-search","kind":"action","action":"click","target":{"by":"role","role":"button","name":"搜索"},"expect":[{"kind":"url_contains","value":"search"}]}'
Get-Content click.step.json | node cli/dist/index.js act --session sXX --step -
```

**`--values <json>`** —— 给该步 `valuesRef` 供值。

```powershell
node cli/dist/index.js act --session sXX --step fill.step.json --values '{"keyword":"虎皮鹦鹉"}'
```

### disconnect —— 断开会话

**`--session <id>`** —— 会话 id（必填）。attach 模式仅断开 CDP 连接，绝不关用户浏览器。

```powershell
node cli/dist/index.js disconnect --session sXX
```

**`--detach-task`** —— 会话下还有暂停任务时仍强制断开（默认拒绝并提示）。

```powershell
node cli/dist/index.js disconnect --session sXX --detach-task
```

## 任务治理

### task —— 任务管理

用法：`node cli/dist/index.js task <get|cancel|resume|approve> <taskId>`（taskId 位置式，或用 `--task <id>` 代替）。

**`task get <taskId>`** —— 查询并打印 envelope；`revision` 字段供乐观锁用。

```powershell
node cli/dist/index.js task get tmumiwtkqa4474d0
node cli/dist/index.js task get --task tmumiwtkqa4474d0 --json
```

**`task cancel <taskId>`** —— 取消任务；先经 `cancelling`，幂等 + 乐观锁。

```powershell
node cli/dist/index.js task cancel tmumiwtkqa4474d0 --request-id r1
```

**`--request-id <id>`** —— cancel/resume 的幂等请求号（缺省自动生成；重试安全）。

```powershell
node cli/dist/index.js task cancel tmumiwtkqa4474d0 --request-id r1
```

**`--expected-revision <n>`** —— 乐观锁版本号；版本落后报 `REVISION_CONFLICT`，重新 `task get` 拿最新 revision 再试。

```powershell
node cli/dist/index.js task cancel tmumiwtkqa4474d0 --request-id r1 --expected-revision 5
```

**`task resume <taskId>`** —— 恢复暂停任务（补 values/密钥、审批通过后）；参数同 cancel（`--request-id`/`--expected-revision`），另加下面两个旗标。

```powershell
node cli/dist/index.js task resume tmumiwtkqa4474d0 --request-id r2
```

**`--rerun-confirm`** —— 动作结果未证实（`ACTION_OUTCOME_UNKNOWN` 隔离）时，人工确认后允许重跑。

```powershell
node cli/dist/index.js task resume tmumiwtkqa4474d0 --request-id r2 --rerun-confirm
```

**`--replan`** —— run 任务允许规划器重规划未完成后缀（受 maxReplans 限制）。

```powershell
node cli/dist/index.js task resume tmumiwtkqa4474d0 --request-id r2 --replan
```

**`task approve <taskId>`** —— 注入审批令牌（配合 `grant create`；之后通常还要 resume）。

```powershell
node cli/dist/index.js task approve tmumiwtkqa4474d0 --grant eyJhbGciOi...
```

**`--grant <token>`** —— 审批令牌（必填；一次性、短 TTL、绑定 actionRevision）。

```powershell
node cli/dist/index.js task approve tmumiwtkqa4474d0 --grant eyJhbGciOi...
```

### artifact —— 产物管理

截图/下载文件都在受管 artifact 区：`<数据目录>\artifacts\<taskId>\`。

**`artifact list`** —— 列出任务产物（artifactId/文件名/大小），stdout JSON。

```powershell
node cli/dist/index.js artifact list --task tmumiwtkqa4474d0
```

**`--task <id>`** —— 任务 id（list 与 get 均必填）。

```powershell
node cli/dist/index.js artifact list --task tmumiwtkqa4474d0
```

**`artifact get`** —— 把产物保存到本地（本地直拷；`--api` 模式走下载接口）。

```powershell
node cli/dist/index.js artifact get --task tmumiwtkqa4474d0 --artifact aXyz --out .\report.xlsx
```

**`--artifact <id>`** —— 产物 id（get 必填；来自 list 输出）。

```powershell
node cli/dist/index.js artifact get --task tmumiwtkqa4474d0 --artifact aXyz --out .\report.xlsx
```

**`--out <path>`** —— 本地保存路径（get 必填）；stderr 打印 `已保存: <path>`。

```powershell
node cli/dist/index.js artifact get --task tmumiwtkqa4474d0 --artifact aXyz --out .\report.xlsx
```

## 审批签发

**grant** 

签发审批令牌

用法：`node cli/dist/index.js grant create --task <id> --action-revision <n>`。前置：环境变量 `JEV_BROWSER_APPROVAL_KEY`（独立审批凭据，与执行侧不同源才构成安全边界）；TTL 取配置 `safety.approvalTtlMs`（默认 120s）。

```powershell
$env:JEV_BROWSER_APPROVAL_KEY = "<审批密钥>"
node cli/dist/index.js grant create --task tmumiwtkqa4474d0 --action-revision 7
```

**`--task <id>`** —— 待批准动作所属任务（必填）。

```powershell
node cli/dist/index.js grant create --task tmumiwtkqa4474d0 --action-revision 7
```

**`--action-revision <n>`** —— 待批准动作版本号（必填；取自 envelope 的 `pendingApproval.actionRevision`）；绑定 revision，动作内容被改即失效。

```powershell
node cli/dist/index.js grant create --task tmumiwtkqa4474d0 --action-revision 7 --json
```

## 退出码与逐错误码排查

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
| `BROWSER_BUSY` | 连不上/起不来浏览器 | attach：见 [方案总览「Chrome配置attach」](../README.md) 的授权教程；固定端口以 `JEV_BROWSER_CDP_ENDPOINT`（默认 9223）为准，被占时不漂移端口，秒级报错并给出占用者 PID 与命令行（换端口需同步改环境变量，或结束占用进程）；launch：profile 被占（另一实例在用）或 Chromium 未装（见 [方案总览「前置条件与构建」](../README.md)） |
| `CAPABILITY_UNSUPPORTED` | 能力缺失 | 按提示执行 `pnpm exec playwright install chromium`（core 目录下）等 |
| `ACTION_FAILED`（后置条件未通过） | expect 没满足 | 看 `details.failures`：选择器不对/页面没跳转/文本不符；`snapshot` 先看页面实际结构 |
| `ACTION_OUTCOME_UNKNOWN` | 动作超时且无法证实结果 | 该 profile 被隔离（新写任务拒绝、只读放行）；人工核查页面后 `task resume --rerun-confirm` |
| `IDEMPOTENCY_CONFLICT` | 同幂等键不同请求体 | 换键或核对请求体；同体重放会返回原任务（这是特性不是错误） |
| `REVISION_CONFLICT` | 乐观锁冲突 | 重新 `task get` 拿最新 revision 再操作 |
| `JEV_NOT_CONFIGURED` / `PLANNER_NOT_CONFIGURED` | 语义步骤/run 缺凭据 | 按 `run` 的「前置」一节配置 `TYPESAFE_API_KEY` / planner 三件套 |
| `INVALID_INPUT`（valuesRef 不存在） | 引用了不存在的变量 | 核对 `--values` 的 key 与 extract 的 `saveAs`（点号路径） |

使用注意：iframe、开放 Shadow DOM 为受限能力（观察脚本不穿透闭合 Shadow DOM）；高风险动作放行后站点弹出的 confirm 仍按保守策略 dismiss。
