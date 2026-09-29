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



## 入口模式与执行器

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



## 连接层

先分清浏览器是谁的。



**attach**

默认。

通过playwright内置方法或读取用户目录下chrome连接信息，进而连接chrome。

不会修改和创建用户会话，而是直接复用现有浏览器会话，执行完毕绝不关用户浏览器，`close()` 仅断开 CDP连接。

 端点只收 loopback（防页面/模型注入远程地址），避免黑客攻击。

 ```
   工具（Playwright 客户端）──发起 CDP 连接──▶ 浏览器（监听在某个端口上，是服务端）
           ↑
           校验发生在这里：
           你给工具指定一个地址时，工具先检查这个地址
           是不是 127.0.0.1 / localhost？
           ├─ 是 → 允许发起连接
           └─ 不是 → 直接拒绝，根本不连
 ```



**launch**

launchPersistentContext：用指定的磁盘目录作为用户数据目录（等价于真实用户的浏览器配置），登录态、扩展  、站点数据跨会话保留。

按 engine 独立 profile 目录，每个引擎一个独立目录，例如：

 ```
   ~/.jev/chromium/
   ~/.jev/firefox/
   ~/.jev/webkit/
 ```

无头仅适用于 launch。

launch 模式下浏览器实例属于启动它的进程——裸 CLI 跨命令复用会话不可行（进程退出浏览器即关），跨命令长会话必须用长驻 API 或 attach。



## 变量体系

 **核心概念**

 任务执行时有两个独立的变量容器，一进一出：

 ```
   📦 values 袋 —— 出发前【你】塞给它的（输入参数）
   📒 vars 本子 —— 干活时【机器人自己】记的（运行数据）
 ```

 

📦 values：启动前传入的参数

 - 来源：命令行 --values '{...}' 或 API 请求体
 - 处理时机：启动时一次性解析，之后只读不写
 - 内容：只能是标量（string / number / boolean / null）
 - secretRef 机制：值写成 {"secretRef":"LOGIN_PW"} 时，启动时从环境变量
   JEV_BROWSER_SECRET_LOGIN_PW 取真值；取不到 → 任务暂停等补，不崩溃；真值只存内存，不落盘
   不进日志

 

📒 vars：运行中产生的数据

 无法预设，只有三种写入者：

 ┌───────────────────────────────┬────────────────────────────────────────────────────────┐
 │ 写入者                        │ 记入内容                                               │
 ├───────────────────────────────┼────────────────────────────────────────────────────────┤
 │ extract 步骤                  │ heading = {text:"...", count:1} 对象                   │
 │ （saveAs:"heading"）          │                                                        │
 ├───────────────────────────────┼────────────────────────────────────────────────────────┤
 │ 下载成功                      │ lastArtifact = 文件编号                                │
 ├───────────────────────────────┼────────────────────────────────────────────────────────┤
 │ forEach 循环                  │ item（当前条目）、rows.processed（进度）、rows.total（ │
 │                               │ 总数，用于断点续跑）                                   │
 └───────────────────────────────┴────────────────────────────────────────────────────────┘

 

🔍 查找规则（核心）

 ① 步骤要用值时（valuesRef: "名字"）：

 ```
   先查 values 袋 → 没有再查 vars 本子 → 都没有就报错停下（不瞎填空值）
 ```

 查到的值必须是标量，是数组/未解析的 secretRef 都报错。

 ② 检查类步骤（assert 的 var_equals、branch 的 variable）：只查 vars 本子。

 引用语法：点号路径，无 ${} 插值

 - 点号路径：heading.text = 先找到 heading，再取它的 text 字段（像"张三.手机号”）
 - 没有模板插值：不支持 "搜索 ${keyword}" 这种把变量拼进字符串的写法（那是 jev-desktop 的语
   法）；引用必须独占一个字段，值是什么就整个填什么
 - 原因（安全）：vars 里的数据来自网页（不可信），只准当纯数据用，不准混进指令文字





## 状态层

SQLite 单库事务。

任务、会话、动作账本、幂等记录、审批授权（grant）、文件（artifact）、预约锁——全部存在同一个数据库，每次变更要么全存、要么全不存。



**任务状态机**

任务的一生只能走规定路线。

 ```
 queued(排队) → running(执行中) → done(完成) / failed(失败) / expired(过期) / cancelled(已取消)
                                     ↑ 主动取消要先经过 cancelling(取消中)
 ```

 暂停态 paused（附带原因，等人处理）：

```
 ┌────────────────────┬──────────────┐
 │ 原因               │ 含义         │
 ├────────────────────┼──────────────┤
 │ likely_done        │ 疑似已完成   │
 ├────────────────────┼──────────────┤
 │ ambiguous          │ 结果说不清   │
 ├────────────────────┼──────────────┤
 │ needs_input        │ 缺信息/密钥  │
 ├────────────────────┼──────────────┤
 │ needs_login        │ 需要登录     │
 ├────────────────────┼──────────────┤
 │ needs_confirmation │ 需要人工确认 │
 ├────────────────────┼──────────────┤
 │ interrupted        │ 被中断       │
 └────────────────────┴──────────────┘
```

铁律：崩溃后绝不自动续跑。

即，崩溃前最后那个动作到底成没成（钱付了没？）机器不知道，宁可停下等人确认，也不能赌一把重跑。





**动作账本**

 每个动作像一张记账凭证，三段流转：

 ```
   prepared(备好未发) → in_flight(执行中) → verified(确认成功) / failed(确认失败) /
 unknown(结果不明)
 ```

 关键规则——非幂等动作超时（非幂等 = 重做会出事的动作：下单、付款、发帖）：

 1. 超时不能盲目重试
 2. 先查证（回页面看实际执行成什么样了）
 3. 查完仍不确定 → 隔离：该浏览器 profile 拒收新的写任务、只读放行；人工确认后
    rerunConfirmed 解除

 │ 人话：不确定钱扣没扣之前，先冻结这张卡的新消费，查清楚再说。



 **幂等记录**

 请求头带 Idempotency-Key（防重号），规则：

 - 同 key + 同请求体 → 重放直接返回原来的任务，不新建
 - 同 key + 不同请求体 → 报 IDEMPOTENCY_CONFLICT（key 疑似被误用）
 - 记录保留 24 小时

 │ 人话：网络超时客户端自动重发很常见，有防重号就不会下两次单。





 **乐观锁**

防两个人同时改一个任务

 cancel / resume 可带 expectedRevision（"我看到的版本是 5"）：

 - 版本还是 5 → 执行
 - 已被别人改成 6 → 报 REVISION_CONFLICT，重新拉取最新状态再试

 │ 人话：像网盘同步冲突提示——"你编辑期间别人改过了，先刷新再操作"。





## 安全模型

 **双层 origin**

两道越收越紧的门禁

 ┌────────┬────────────────┬───────────────────────────────────────────────────────┐
 │ 层     │ 名字           │ 管什么                                                │
 ├────────┼────────────────┼───────────────────────────────────────────────────────┤
 │ 第一道 │ allowedOrigins │ 本会话能访问哪些域                                    │
 ├────────┼────────────────┼───────────────────────────────────────────────────────┤
 │ 第二道 │ modelOrigins   │ 哪些域的页面摘要能外发给云模型（必须 ⊆ 第一道的子集） │
 └────────┴────────────────┴───────────────────────────────────────────────────────┘

 - 默认两者皆空 = 不许可任何网站、禁止任何云外发
 - 域外导航/动作 → 报 ORIGIN_NOT_ALLOWED
 - 域外内容要外发 → needs_input 暂停
 - API/MCP 任务只能从宿主已许可的域里选子集，不能自行扩权



**PolicyGate**

动作派发前的安检机

 每个动作执行前综合判定（动作类型 + 目标名 + 域）：
 - 命中风险 pattern（支付/删除/发送/pay…）→ 一律 paused + needs_confirmation
 - 只拦不执行，等人工批准



**审批 grant**

一次性短时效通行令牌

 解锁危险动作靠 HMAC 签发的 token，三个特点：

 1. 一次性：用过即废
 2. 短 TTL：活得不久
 3. 绑定 actionRevision：动作内容被改 → 令牌立即失效（防偷梁换柱）

 最关键设计：签发钥匙 JEV_BROWSER_APPROVAL_KEY 不在执行 Agent 手里——它自己签不了，所以无法
 自己批准自己。



**secretRef**

密码只存暗号，不存明文

 - 任务里写 {"secretRef":"NAME"}（暗号），运行时从环境变量 JEV_BROWSER_SECRET_<NAME> 兑出真
   值
 - 全程只在内存中：不落盘、不进模型请求体、不进日志





## 错误与输出模型

**错误三要素**

code / message / retryable

 规则：任何错误都必须带这三个字段，一个不能少。

 ┌───────────┬────────────┬──────────────────────────────────────────────────────────┐
 │ 字段      │ 给谁看     │ 作用                                                     │
 ├───────────┼────────────┼──────────────────────────────────────────────────────────┤
 │ code      │ 给程序看   │ 机器可读的错误编号，调用方可以 switch(code) 精确分支处理 │
 ├───────────┼────────────┼──────────────────────────────────────────────────────────┤
 │ message   │ 给人看     │ 一句话说清楚发生了什么                                   │
 ├───────────┼────────────┼──────────────────────────────────────────────────────────┤
 │ retryable │ 给自动化看 │ 这个错重试有没有意义？                                   │
 └───────────┴────────────┴──────────────────────────────────────────────────────────┘

 为什么 retryable 重要——错误分两类：

 - ✅ 可重试：网络抖了一下、浏览器没响应 → 等一会再试就行
 - ❌ 不可重试：浏览器没安装、参数写错了 → 重试 100 次也没用，只会浪费资源

 没有这个标志，自动化脚本就得「无脑重试所有错误」或「一律不重试」，两头都吃亏。

 错误码全集集中在 core/src/types.ts → 单一事实来源，新增错误只能在这里登记，不会散落各处各自发明。



**统一输出 TaskEnvelope + 双通道**

 规则：不管命令执行什么，输出都包在同一个「信封」里（TaskEnvelope），内部包含状态、结果、错误、元数据等固定字段。

 关键设计是两个输出通道分离：

 ```
   stdout（正门）──→ --json 时的完整 envelope → 给程序消费
   stderr（侧门）──→ 人读的摘要文案        → 给坐在屏幕前的人看
 ```

 为什么这么分？

 - stdout 保持纯净：jev-browser xxx --json | jq '.result' 这样的管道操作永远可靠，不会被「正在启动浏览器…」这种
   提示语污染
 - 人也不委屈：摘要写到 stderr，终端上照样能看到，但不会混进数据流



# 前置条件与构建

| 项     | 要求   | 说明                                                         |
| ------ | ------ | ------------------------------------------------------------ |
| Node   | ≥ 24   | 任务库用 `node:sqlite`（24 起内置），低版本启动即报错        |
| 浏览器 | 二选一 | attach（默认）：本机 Chrome ≥ 144 + 人工授权（见「Chrome配置attach」）；launch：Playwright 管理的 Chromium（可自动装，仅显式 `JEV_BROWSER_MODE=launch` 时使用） |

```powershell
cd tools/jev-browser
npm install && npm run build
node cli/dist/index.js help        # 打印命令帮助 → 构建成功
npm test                           # 62 个离线测试，无需浏览器/key
```

（可选）Chromium 运行时：默认 attach 模式**不需要**安装；仅显式切换 launch + chromium 时首次需要（约 115MB，国内可加镜像）：

```powershell
$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://cdn.npmmirror.com/binaries/playwright"
npx playwright install chromium
```



**配置模型信息**

 PowerShell（Windows，永久·写入用户环境变量）

 ```powershell
 setx TYPESAFE_API_KEY "apikey_22520acff6f35a0a466db7e645627695e33b_bcb07a31362051ad3ec0c6d07b0c5a75f1995927de97367d85f15bcf11aad0d6"
 setx JEV_BROWSER_PLANNER_ENABLED  "true"
 setx JEV_BROWSER_PLANNER_PROVIDER "openai-compatible"
 setx JEV_BROWSER_PLANNER_BASE_URL "https://open.bigmodel.cn"
 setx JEV_BROWSER_PLANNER_MODEL    "deepseek-chat"
 setx JEV_BROWSER_PLANNER_API_KEY  "<规划模型 key>"
 ```

# Chrome配置attach

attach = 借用你**已打开、已登录**的日常 Chrome（不新开实例、不复制 Cookie、断开时绝不关你的浏览器）。



**一次性开启授权**

1. 确认 Chrome ≥ 144（地址栏 `chrome://version` 看 major 版本）；
2. 地址栏打开 `chrome://inspect/#remote-debugging`；
3. 勾选 **"Allow remote debugging for this browser instance"**。



**固定端口调试（自动，无需手动步骤）**

CLI / MCP / API 的 attach 连接已内置「固定端口自动确保」逻辑，连接前探测 `127.0.0.1:9222`：

```powershell
# 直接执行（首次会自动拉起 9222 调试 Chrome）：
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
node cli/dist/index.js doctor --connect
```



等价的手动做法（仅 Windows，供理解原理）：

```powershell
# 以指定debug端口启动谷歌浏览器，不然谷歌浏览器启动会随机调试端口（先检查 9222 是否已在监听，在跑就不重复启动）。
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=D:\chrome-debug-profile

# 设置attach连接谷歌浏览器的地址。
$env:JEV_BROWSER_CDP_ENDPOINT = "http://127.0.0.1:9222"

# macOS 等价写法：
# "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/Library/Application Support/AI-Redfish/jev-browser/chrome-debug-profile"
# export JEV_BROWSER_CDP_ENDPOINT="http://127.0.0.1:9222"
```

**注意：自动拉起的是独立 profile 的调试 Chrome**——登录态与日常浏览器不共享；需要借用已登录的日常 Chrome 时，按上面「一次性开启授权」操作，或在日

常 Chrome 已运行时让哨兵路径优先接管它。



**环境变量**

```powershell
# 清掉 launch 相关覆盖（attach 是默认 mode，不要设 MODE/ENGINE/HEADLESS）
Remove-Item Env:JEV_BROWSER_MODE, Env:JEV_BROWSER_ENGINE, Env:JEV_BROWSER_HEADLESS -ErrorAction SilentlyContinue

# 每次 attach 尝试有“硬超时”保护（默认 60s，超时报 `BROWSER_BUSY` 并附指引），可用环境变量调整：
$env:JEV_BROWSER_CONNECT_TIMEOUT_MS = "60000" 
```



**验证**

```
# 先单独验证：成功输出 [connect] OK: ...
node cli/dist/index.js doctor --connect

# 验证
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```

# CLI 方式

**参数书写规则**

- 取值参数两种写法等价：`--origin https://a.com` 与 `--origin=https://a.com`；值本身以 `--` 开头时必须用等号形式。
- 可重复参数（`--origin`、`--model-origin`）传多次会自动累积为数组。
- 旗标（布尔开关，后面不跟值）：`--json`、`--connect`、`--for-model`、`--detach-task`、`--rerun-confirm`、`--replan`、`--no-save`。
- JSON 参数（`--file`/`--steps`/`--values`/`--step`）三种等价写法：内联 JSON 字符串、已存在的文件路径、`-`（从 stdin 读）。



## 全局参数

所有子命令可用。

**`--config <path>`** —— 显式指定配置文件（文件必须存在且合法）；默认自动搜索（`--config` > 环境变量 `JEV_BROWSER_CONFIG` > 用户配置目录）。实际生效的文件与 `JEV_BROWSER_*` 环境变量覆盖可用 `doctor` 查看。

```powershell
node cli/dist/index.js doctor --config examples/config.attach-chrome.json
```

**`--json`** —— stdout 输出完整 envelope / 结构化 JSON（供程序消费）；不带时任务类命令只在 stderr 打印人读摘要，stdout 保持纯净便于管道。

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com" --json | jq ".status"
```

**`--api <url>`** —— API 转发模式：命令转发到长驻 API（如 `http://127.0.0.1:3737`），Bearer token 取环境变量 `JEV_BROWSER_API_TOKEN`。该模式下 execute/run/act/snapshot 必须先 `connect` 再传 `--session`（不支持一次性 `--url`/`--page`）；`chrome-debug` 是本机操作，不支持转发。

```powershell
node cli/dist/index.js doctor --api http://127.0.0.1:3737
node cli/dist/index.js pages --api http://127.0.0.1:3737 --session sXX
```

**`--principal <name>`** —— 调用者身份标识（默认 `local`），记入会话/任务/动作账本用于权限校验；仅本地模式生效（`--api` 模式下身份由 token 代表）。

```powershell
node cli/dist/index.js --principal alice connect --url "https://example.com" --origin "https://example.com"
```

**`--help`** —— 向 stderr 打印命令速览，退出码 0；等价于不带参数运行或 `help` 子命令（注意：`-h` 单横线不是本 CLI 的旗标）。

```powershell
node cli/dist/index.js execute --help
```



## 子命令详解

按分类组织：环境与诊断 → 一次性执行 → 长会话交互 → 任务治理 → 审批签发（建议按此顺序上手；分场景教程见 2.1～2.8）。

### 环境与诊断

#### help —— 帮助速览

无参数。向 stderr 打印全部命令与参数速览，退出码 0。三种等价触发方式：

```powershell
node cli/dist/index.js
node cli/dist/index.js help
node cli/dist/index.js execute --help
```

#### doctor —— 环境与配置诊断

静态检查 Node 版本、数据目录、配置文件、环境变量覆盖、凭据与浏览器能力，逐项输出 `[OK]/[FAIL]`；不带 `--connect` 时退出码 0。

```powershell
node cli/dist/index.js doctor
```

**`--connect`** —— 在静态检查之上额外尝试真实接管浏览器（attach），输出 `[connect] OK/FAIL: ...`；失败退出码 4。

```powershell
node cli/dist/index.js doctor --connect
```

#### chrome-debug —— 固定调试端口启动/复用 Chrome

attach 连接已自动确保固定端口（见「Chrome配置attach」），本命令是手动预热/预配置入口。不带参数时探测 9222，有则复用、无则拉起，并把 attach 端点写入用户配置。

```powershell
node cli/dist/index.js chrome-debug
```

**`--port <n>`** —— 固定调试端口（默认 9222）；先探测该端口，已有调试 Chrome 在跑就复用（不重复启动）。

```powershell
node cli/dist/index.js chrome-debug --port 9223
```

**`--user-data-dir <目录>`** —— 调试专用 profile 目录（绝不用日常默认目录，Chrome 136+ 会拒绝在默认目录开调试端口）。默认按平台选取，见「Chrome配置attach」。

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

### 一次性执行

#### execute —— 确定性步骤（零模型调用）

执行 FlowStep 数组（action/assert/extract/branch/forEach），不调用任何模型；步骤契约见 2.6。任务落定后按状态退出：0 done / 3 paused / 4 failed / 130 cancelled。

**`--file <path>`** —— FlowStep 数组文件；也接受完整 flow 对象 `{schemaVersion, steps}`，自动拆包取 steps。与 `--steps` 二选一，同时给时 `--file` 优先。

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```

**`--steps <json>`** —— 直接给 FlowStep 数组。三种等价写法：内联 JSON 字符串、已存在的文件路径、`-`（从 stdin 读）。

```powershell
node cli/dist/index.js execute --steps '[{"id":"go","kind":"action","action":"navigate","value":"https://example.com","expect":[{"kind":"url_contains","value":"example.com"}]}]' --url "https://example.com" --origin "https://example.com"
echo '[{"id":"go","kind":"action","action":"navigate","value":"https://example.com","expect":[{"kind":"url_contains","value":"example.com"}]}]' | node cli/dist/index.js execute --steps - --url "https://example.com" --origin "https://example.com"
```

**`--url <url>`** —— 目标页三选一（`--url`/`--page`/`--session`）：一次性会话，自动新开页、跑完自动断开（需配 `--origin`）。

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```

**`--page <id>`** —— 目标页三选一：绑定既有标签页的一次性会话（pageId 来自 `pages` 输出，如 `p0`）。

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --page p0 --origin "https://example.com"
```

**`--session <id>`** —— 目标页三选一：复用长会话（跨命令场景，先见 `connect`）。

```powershell
node cli/dist/index.js execute --file bili-open4.flow.json --session sXX
```

**`--origin <o>`** —— 会话授权域（可重复传；一次性会话必填*）。默认空 = 不许可任何网站，首个域外动作报 `ORIGIN_NOT_ALLOWED`（*CLI 不强制校验，MCP 侧为硬必填）。搜索页/详情页常是两个域，都要声明。

```powershell
node cli/dist/index.js execute --file search.flow.json --url "https://www.bilibili.com" --origin "https://www.bilibili.com" --origin "https://search.bilibili.com"
```

**`--model-origin <o>`** —— 允许页面摘要外发云模型的域（可重复，必须 ⊆ origin）；默认空 = 禁止外发。flow 含 goal 语义步骤时必须声明。

```powershell
node cli/dist/index.js execute --file with-goal.flow.json --url "https://example.com" --origin "https://example.com" --model-origin "https://example.com"
```

**`--values <json>`** —— 变量初值（标量字典），供步骤 `valuesRef` 引用（三大用法见 2.3）。

```powershell
node cli/dist/index.js execute --file search.flow.json --url "https://www.bilibili.com" --origin "https://www.bilibili.com" --origin "https://search.bilibili.com" --values '{"startUrl":"https://www.bilibili.com","keyword":"虎皮鹦鹉"}'
```

**`--idempotency-key <k>`** —— 幂等键：同 key + 同请求体重放返回原任务；同 key + 不同请求体报 `IDEMPOTENCY_CONFLICT`（防网络超时重发重复下单）。

```powershell
node cli/dist/index.js execute --file order.flow.json --session sXX --idempotency-key order-20260101-001
```

#### snapshot —— 只读快照

stdout 总是输出快照 JSON（不受 `--json` 影响）；`elements` 含 role/name/text，供写 flow 定位。

**`--url <url>`** —— 快照目标三选一（`--url`/`--page`/`--session`）：自动建临时会话、快照后自动断开（需配 `--origin`）。

```powershell
node cli/dist/index.js snapshot --url "https://example.com" --origin "https://example.com"
```

**`--page <id>`** —— 快照目标三选一：绑定既有标签页的一次性快照。

```powershell
node cli/dist/index.js snapshot --page p0 --origin "https://example.com"
```

**`--session <id>`** —— 快照目标三选一：长会话方式，快照当前绑定页。

```powershell
node cli/dist/index.js snapshot --session sXX
```

**`--origin <o>`** —— 一次性方式（`--url`/`--page`）必填*的临时会话授权域（规则同 execute）。

```powershell
node cli/dist/index.js snapshot --url "https://example.com" --origin "https://example.com"
```

**`--model-origin <o>`** —— 同 execute：允许外发云模型的域（⊆ origin）。

```powershell
node cli/dist/index.js snapshot --url "https://example.com" --origin "https://example.com" --model-origin "https://example.com"
```

**`--for-model`** —— 声明快照将发云模型：要求当前页 origin ∈ modelOrigins，否则拒绝（默认禁止外发）。

```powershell
node cli/dist/index.js snapshot --session sXX --for-model
```

#### run —— 自主任务（规划 + 执行）

前置（一次性配置；规划器与 Jev 是两份独立凭据）：

```powershell
$env:JEV_BROWSER_PLANNER_ENABLED = "true"
$env:JEV_BROWSER_PLANNER_BASE_URL = "https://api.deepseek.com/v1"
$env:JEV_BROWSER_PLANNER_MODEL = "deepseek-chat"
$env:JEV_BROWSER_PLANNER_API_KEY = "<规划模型 key>"
$env:TYPESAFE_API_KEY = "<Jev key>"
```

**`--goal <文本>`** —— 自然语言目标（必填）。

```powershell
node cli/dist/index.js run --url "https://search.bilibili.com/all?keyword=%E8%99%8E%E7%9A%AE%E9%B9%A6%E9%B9%89" --goal "在当前B站搜索结果页，按顺序找到第4条视频结果并打开它" --success "当前页是 bilibili 视频播放页（URL 含 /video/BV），且视频标题与搜索结果第4条一致" --origin "https://search.bilibili.com" --origin "https://www.bilibili.com"
```

**`--success <文本>`** —— 人类可读验收条件（必填）；任务级验收由引擎执行，规划器不能自证完成（两层验收见技术原理）。

```powershell
node cli/dist/index.js run --url "https://example.com" --goal "打开页面并确认标题" --success "页面标题为 Example Domain" --origin "https://example.com"
```

**`--url <url>`** —— 目标页三选一（`--url`/`--page`/`--session`）：一次性会话（语义同 execute）。

```powershell
node cli/dist/index.js run --url "https://example.com" --goal "..." --success "..." --origin "https://example.com"
```

**`--page <id>`** —— 目标页三选一：绑定既有标签页。

```powershell
node cli/dist/index.js run --page p0 --goal "..." --success "..." --origin "https://example.com"
```

**`--session <id>`** —— 目标页三选一：复用长会话。

```powershell
node cli/dist/index.js run --session sXX --goal "..." --success "..."
```

**`--origin <o>`** —— 一次性会话必填*的授权域（规则同 execute，可重复）。

```powershell
node cli/dist/index.js run --url "https://search.bilibili.com/all?keyword=虎皮鹦鹉" --goal "..." --success "..." --origin "https://search.bilibili.com" --origin "https://www.bilibili.com"
```

**`--model-origin <o>`** —— 可外发域（⊆ origin）；run 的任务级验收本身也要外发，不给会暂停 `likely_done`。

```powershell
node cli/dist/index.js run --url "https://search.bilibili.com/all?keyword=虎皮鹦鹉" --goal "..." --success "..." --origin "https://search.bilibili.com" --origin "https://www.bilibili.com" --model-origin "https://search.bilibili.com" --model-origin "https://www.bilibili.com"
```

**`--values <json>`** —— 变量初值（供规划产物的 `valuesRef` 使用）。

```powershell
node cli/dist/index.js run --session sXX --goal "..." --success "..." --values '{"keyword":"虎皮鹦鹉"}'
```

**`--idempotency-key <k>`** —— 幂等键（语义同 execute）。

```powershell
node cli/dist/index.js run --session sXX --goal "..." --success "..." --idempotency-key run-001
```

### 长会话交互

一次性会话「跑完即断」；要在同一页面上多轮交互（观察 → 操作 → 再观察），先 `connect` 建会话，后续命令都传 `--session`：

```powershell
node cli/dist/index.js snapshot --session sXX                               # 观察当前绑定页
node cli/dist/index.js execute --session sXX --file bili-open4.flow.json    # 在会话上跑确定性步骤
node cli/dist/index.js run --session sXX --goal "..." --success "..."       # 在会话上跑自主任务
```

#### connect —— 建会话

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

#### pages —— 列标签页

**`--session <id>`** —— 会话 id（必填）。列出会话可见标签页（按授权域过滤、URL 脱敏）；典型用途：找 `target=_blank` 新开页的 pageId。

```powershell
node cli/dist/index.js pages --session sXX
```

#### select-page —— 切换绑定页

**`--session <id>`** —— 会话 id（必填）。

```powershell
node cli/dist/index.js select-page --session sXX --page p2
```

**`--page <id>`** —— 要切换到的标签页 id（必填，来自 `pages` 输出）。

```powershell
node cli/dist/index.js select-page --session sXX --page p2
```

#### act —— 单步动作

在既有会话上执行一个动作并等待任务落定；适合「snapshot 观察 → act 操作」交互循环。

**`--session <id>`** —— 长会话 id（必填；无一次性形态，必须先 `connect`）。

```powershell
node cli/dist/index.js act --session sXX --step click.step.json
```

**`--step <json>`** —— 单个 ActionStep（必填；结构见 2.6 的 `action` 行）；三种写法：内联 JSON / 文件路径 / `-` stdin。

```powershell
node cli/dist/index.js act --session sXX --step '{"id":"click-search","kind":"action","action":"click","target":{"by":"role","role":"button","name":"搜索"},"expect":[{"kind":"url_contains","value":"search"}]}'
Get-Content click.step.json | node cli/dist/index.js act --session sXX --step -
```

**`--values <json>`** —— 给该步 `valuesRef` 供值。

```powershell
node cli/dist/index.js act --session sXX --step fill.step.json --values '{"keyword":"虎皮鹦鹉"}'
```

#### disconnect —— 断开会话

**`--session <id>`** —— 会话 id（必填）。attach 模式仅断开 CDP 连接，绝不关用户浏览器。

```powershell
node cli/dist/index.js disconnect --session sXX
```

**`--detach-task`** —— 会话下还有暂停任务时仍强制断开（默认拒绝并提示）。

```powershell
node cli/dist/index.js disconnect --session sXX --detach-task
```

### 任务治理

#### task —— 任务管理

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

#### artifact —— 产物管理

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

### 审批签发

#### grant —— 签发审批令牌

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

---

以下 2.1～2.8 为分场景教程与契约速查。

#### 2.1 第一条命令与 flow 逐字段精讲

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
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
      "id": "read-link",
      "kind": "extract",       // 提取步骤：读页面数据存入流程变量
      "target": {              // LocatorSpec 白名单定位（模型不得生成任意 XPath/JS）
        "by": "role", "role": "link", "name": "Learn more", "exact": true   // example.com 已改版：无 h1，改提取页内链接
      },
      "fields": ["text", "count"],   // 要提取的字段：text=首个匹配的innerText；count=匹配元素数
      "saveAs": "link"        // 存入 vars["link"] = { text, count } → 后续用点号引用 "link.text"
    },
    {
      "id": "verify-link",
      "kind": "assert",        // 纯断言步骤（不动页面）
      "expect": [
        { "kind": "var_equals", "variable": "link.text", "value": "Learn more" }
        // var_equals/var_contains/var_exists 引用变量用 variable 字段（点号路径）
      ]
    },
    { "id": "shot", "kind": "action", "action": "screenshot" }   // 截图存 artifact（只读动作可不带 expect）
  ],
  "values": {}                 // CLI 只读取 steps；变量一律用 --values 传（此处 values 字段不被 CLI 读取）
}
```

execute 各参数的逐一说明与案例见「子命令详解 → 一次性执行 → execute」。

预期输出（stderr 摘要，退出码 0）：

```text
status=done taskId=a1b2c3 revision=5
  step goto [action] done
  step read-link [extract] done
  step verify-link [assert] done
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
    { "id": "read-link", "kind": "extract", "status": "done", "savedAs": "link" }
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
node cli/dist/index.js execute --file search.flow.json `
  --url "https://www.bilibili.com" --origin "https://www.bilibili.com" --origin "https://search.bilibili.com" `
  --values '{"startUrl":"https://www.bilibili.com","keyword":"虎皮鹦鹉"}'
# 换词重跑只改 --values：..."keyword":"玄凤鹦鹉"...，flow 一个字不动
```

解析规则（`executor.ts resolveValue`）：步骤写 `valuesRef` → 先查 `--values` 字典 → 查不到回退流程变量（如 `heading.text`）→ 都没有报 `INVALID_INPUT` 且**动作不派发**；没写 `valuesRef` 用步骤 `value` 字面值；引用到数组/未解析的 secretRef 均报错（动作输入必须是标量）。

**用法二：敏感值走 secretRef**（密码不进命令行/文件/日志）：

```powershell
$env:JEV_BROWSER_SECRET_LOGIN_PW = "真实密码"     # ① 密码只放环境变量（名字任意，前缀固定）
node cli/dist/index.js execute --file login.flow.json `
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

本节用到的命令（connect / pages / select-page / snapshot / act / disconnect）参数逐一说明与案例见「子命令详解 → 长会话交互」。

实测示例（无 key 可照抄，用 `--api` 长驻模式；B 站搜索并打开第 4 条结果）：

```powershell
# 终端 1：起长驻 API（attach 默认模式：接管日常 Chrome，连接时自动探测/拉起 9222 调试 Chrome，见「Chrome配置attach」）
$env:JEV_BROWSER_API_TOKEN = "<随机长串>"
# attach 是默认 mode，勿设 JEV_BROWSER_MODE/ENGINE/HEADLESS（设过就先清掉：见「Chrome配置attach → 环境变量」）
node api/dist/index.js

# 终端 2：以下命令都带 --api 与同一 token；$api = "--api http://127.0.0.1:3737"
# ① 建会话（搜索页与视频页是两个 origin，都要声明）
node cli/dist/index.js connect $api --url "https://search.bilibili.com/all?keyword=%E8%99%8E%E7%9A%AE%E9%B9%A6%E9%B9%89" --origin "https://search.bilibili.com" --origin "https://www.bilibili.com"
# ② 快照观察结果列表（确认渲染、看清标题与顺序）
node cli/dist/index.js snapshot $api --session <sessionId> --json
# ③ 点击第 4 条（推荐按②里看到的完整标题精确文本点击；flow 示例）
#    [ { "id":"wait", "kind":"action", "action":"wait", "target":{"by":"css","selector":".bili-video-card"}, "value":2000 },
#      { "id":"open", "kind":"action", "action":"click",
#        "target":{"by":"text","text":"<第4条完整标题>","exact":true},
#        "expect":[{"kind":"url_contains","value":"search.bilibili.com"}] },
#      { "id":"shot", "kind":"action", "action":"screenshot" } ]
node cli/dist/index.js execute $api --session <sessionId> --file bili-open4.flow.json
# ④⑤ 查看/切换 target=_blank 新开的视频页并验证
node cli/dist/index.js pages $api --session <sessionId>
node cli/dist/index.js select-page $api --session <sessionId> --page <新页id>
node cli/dist/index.js snapshot $api --session <sessionId>
# ⑥ 断开
node cli/dist/index.js disconnect $api --session <sessionId>
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
node cli/dist/index.js execute --file download.flow.json --url "https://example.com/report" --origin "https://example.com"
# 摘要输出 artifacts: aXyz(report-2026.xlsx,20480B) —— 文件在 <数据目录>\artifacts\<taskId>\

# 取回本地：
node cli/dist/index.js artifact list --task <taskId>
node cli/dist/index.js artifact get --task <taskId> --artifact aXyz --out .\report.xlsx
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

run 各参数的逐一说明与案例见「子命令详解 → 一次性执行 → run」。

```powershell
node cli/dist/index.js run `
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
node cli/dist/index.js grant create --task <taskId> --action-revision 7      # → 输出 grant token（--json 时输出 {grant, ttlMs}）
# ② 注入批准（grant 一次性、短 TTL、绑定 actionRevision，动作被改即失效）
node cli/dist/index.js task approve <taskId> --grant <token>
# ③ 恢复任务（request-id 幂等，重试安全）
node cli/dist/index.js task resume <taskId> --request-id r1
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



# 步骤 4：MCP 使用（Agent 宿主）

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



### 步骤 6：仓库启动器（统一 MCP 入口）

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list                # 应列出 jev-browser
node bin/tool-launcher.js build jev-browser   # 只装依赖并构建
node bin/tool-launcher.js jev-browser         # 以 MCP stdio 拉起（缺 dist 自动构建）
```



# 步骤 5：长驻 HTTP API 使用（多客户端共享 / 跨语言集成）

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

