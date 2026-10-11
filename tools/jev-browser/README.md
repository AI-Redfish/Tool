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
pnpm install && pnpm build         # 首选 pnpm（托管 pnpm-lock.yaml，安装可复现）
node cli/dist/index.js help        # 打印命令帮助 → 构建成功
pnpm test                          # 64 个离线测试，无需浏览器/key
```

> 未装 pnpm 时可用 npm 回退：`npm install && npm run build`。但 npm 与 pnpm 的
> `node_modules` 布局互不兼容，切换包管理器前必须先删除 `node_modules`，否则 npm 会报
> `Cannot read properties of null (reading 'matches')`（详见 `.npmrc` 内注释）。

（可选）Chromium 运行时：默认 attach 模式**不需要**安装；仅显式切换 launch + chromium 时首次需要（约 115MB，国内可加镜像）：

```powershell
cd tools\jev-browser\core   # 在 core 包内执行，避免解析到系统里其他语言的 playwright
pnpm exec playwright install chromium
```

> 注意：不要在仓库根目录裸敲 `npx playwright install chromium`——Playwright 是 `core` 包的依赖，
> 根目录没有它的 bin shim，`npx` 会回退到 PATH 查找，若系统装有 Python 版 playwright
> （如 conda 环境）会命中那个损坏的脚本（报 `No module named 'playwright.__main__'`）。



**配置模型信息**

 PowerShell（Windows，永久·写入用户环境变量）

 ```powershell
 setx TYPESAFE_API_KEY "XXX"
 setx JEV_BROWSER_PLANNER_ENABLED  "true"
 setx JEV_BROWSER_PLANNER_PROVIDER "openai-compatible"
 setx JEV_BROWSER_PLANNER_BASE_URL "https://open.bigmodel.cn/api/coding/paas/v4"
 setx JEV_BROWSER_PLANNER_MODEL "glm-5.3-flash"
 setx JEV_BROWSER_PLANNER_API_KEY  "XXX"
 ```

# Chrome配置attach

attach = 借用你**已打开、已登录**的日常 Chrome（不新开实例、不复制 Cookie、断开时绝不关你的浏览器）。



**一次性开启授权**

1. 确认 Chrome ≥ 144（地址栏 `chrome://version` 看 major 版本）；
2. 地址栏打开 `chrome://inspect/#remote-debugging`；
3. 勾选 **"Allow remote debugging for this browser instance"**。

> 为什么每次连接都弹「允许」？这是 Chrome 144+ 对**日常浏览器**的安全设计（授权通道逐次批准），无法关闭。
> **想免弹窗**：改用固定端口调试 Chrome（独立 profile，固定端口连接永不弹窗）：
> `node cli/dist/index.js chrome-debug --port 9223`（端点自动写入用户配置，之后免环境变量、免点击；
> 调试 Chrome 被关闭时，下次连接会自动以同端口同 profile 重新拉起）。日常 Chrome 无需关闭。



**环境变量**

```powershell
# 清掉 launch 相关覆盖（attach 是默认 mode，不要设 MODE/ENGINE/HEADLESS）
Remove-Item Env:JEV_BROWSER_MODE, Env:JEV_BROWSER_ENGINE, Env:JEV_BROWSER_HEADLESS -ErrorAction SilentlyContinue

# 每次 attach 尝试有“硬超时”保护（默认 60s，超时报 `BROWSER_BUSY` 并附指引），可用环境变量调整：
$env:JEV_BROWSER_CONNECT_TIMEOUT_MS = "60000" 
```



**固定端口调试（自动，无需手动步骤）**

CLI / MCP / API 的 attach 连接已内置「固定端口自动确保」逻辑，连接前探测 `127.0.0.1:9223`：

```powershell
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
node cli/dist/index.js doctor --connect
```



**验证**

```
# 先单独验证：成功输出 [connect] OK: ...
node cli/dist/index.js doctor --connect

# 验证
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com" --origin "https://example.com"
```

# 使用方式

CLI、MCP、HTTP API 只是三种协议翻译层，共用同一套 Runtime（core），行为与输出契约（TaskEnvelope）完全一致。各入口的完整参数说明单独成篇：

| 入口 | 文档 | 内容 |
|---|---|---|
| **CLI** | [docs/cli.md](docs/cli.md) | 全局参数、`execute`/`snapshot`/`run`/`connect` 等子命令逐参数说明、任务治理、审批签发、退出码与错误码排查 |
| **MCP** | [docs/mcp.md](docs/mcp.md) | Agent 宿主注册、14 个工具与参数全表、典型调用序列、仓库启动器（统一 MCP 入口） |
| **HTTP API** | [docs/api.md](docs/api.md) | 长驻服务（loopback + bearer token）启动、路由总表、curl 最小闭环、MCP 转发模式 |

