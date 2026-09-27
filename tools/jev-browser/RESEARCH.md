# jev-browser 研究依据、假设与风险

> 方案版本：v0.2；核对日期：2026-09-24。仅完成本地源码/文档阅读与公开资料核对，没有连接用户 Chrome、调用付费模型或执行浏览器实测。
> **v0.1 实现轮注记**：四包工作区与执行引擎已实现，50 个离线测试通过；实现过程中已核实的库事实——`@typesafe-ai/sdk` 0.6.0 的 `TypeSafeClient.systemOne({state,model,questions}) → {model, answers, usage}` 与 noul/choice 返回形状与 S7/S8 一致；Playwright 1.63.0 的 `ConnectOverCDPOptions.noDefaults` 存在（文档原文见 types）；`BrowserContext.newPage()` 无 url 参数、`Locator.waitFor` 为单 options 对象。S12/S13 的在线复核仍待完成；P0 实测仍阻塞默认接管路径的正式承诺。
> 配套文档：[设计](DESIGN.md)、[开发计划](DEVELOPMENT_PLAN.md)。

## 1. 本地规范依据

已读取并据此设计：

- 仓库根 `README.md`：启动器 + 工具集合；核心逻辑/适配器分离；源码、配置和锁文件的托管边界。
- `tools/README.md`：TypeScript 工作区、core/cli/mcp、pnpm/npm 双路径、统一 TOOLS 元数据。
- `bin/tool-launcher.js`：工具发现、安装/构建规则、默认 `mcp/dist/index.js`、子进程 cwd 与 stderr 约束。
- `tools/server-a/core/src/index.ts`、工作区 `package.json`：元数据/handler 组织与工程依赖方式。
- `doc/06.浏览器操作/ChromeMCPServer/ChromeMCPServer.md`：已有浏览器资料入口；其仅指向另一项目，不当作本工具必须复用某个扩展的要求。
- 当前工作空间 `AGENTS.md`：先澄清真实需求、再审查输出；本任务已通过多轮对话确认 A/B 共存与效率优先。
- TypeSafe 技能说明：读取当前官方 API/SDK/判断原语/模式，代码控制流程，模型处理局部判断。

仓库在开始时已有未提交改动；本次不重置、不覆盖。只新增本工具的规划文档，并在两个索引文件中插入“规划中”入口；不把它加入“可用工具”表。

特别注意：根启动器会把子进程 cwd 切到 MCP 构建入口所在目录。配置发现不能依赖“当前目录恰好是仓库根”，也不应自动从该目录读取 `.env`。

## 2. 参考项目快照与差异

上游仓库：`Ying-Kai-Liao/jev-browser`。核对的 commit 为：

```text
e35ab134f65033d29c528132d92bf06e8d6adcb5
commit time: 2026-09-22T06:55:37Z
```

阅读范围：README、NOTES、LICENSE、package.json、`src/session.mjs` 的启动/监听/关闭逻辑、`src/jev.mjs`、`src/flow.mjs`。上游是非官方 TypeSafe 项目。[S1、S2]

| 项目 | 上游可借鉴点 / 实现现状 | 本工具的设计调整 |
| --- | --- | --- |
| 分工 | 外部 LLM 规划，Jev 局部选择，Playwright 执行 | 保留；另加可选内部规划器 |
| 多问题 | 同一次 API 请求问多个独立问题 | 保留，补跨参数一致性、候选时效、隐私策略 |
| 默认浏览器 | launch Chromium，默认 headless | 默认授权 attach 日常 Chrome、有头 |
| 传入 browser | `launch` 的非 userDataDir 分支仍新建 context | 必须使用已接管默认 context，保留日常登录态 |
| 生命周期 | `close()` 会尝试关闭 context | 显式区分 borrowed/owned，禁止关借用 context |
| CLI run | 顺序运行调用者提供的 JSON flow | 本工具 `execute` 对应已有 flow；`run` 是内部任务规划，两者名称语义不可混淆 |
| 状态 | done/likely_done/ambiguous/needs_login 等；flow 将 likely_done 也记为 ok | 本工具不把 likely_done 计为成功；补证据后再继续 |
| flow assert | 允许把调用者提供的 JS 函数文本放到 page.evaluate 执行 | 本工具改为白名单断言，禁用任意代码入口 |
| 不可逆操作 | 概率风险判断与 allow 参数 | 代码策略 + 细粒度一次授权；不照搬全局不可逆放行开关 |
| 大页面 | 分组候选、差量、计数 | 保留思路；服务限制和候选覆盖用契约测试约束 |
| 多入口 | 库、CLI、MCP | 本仓库 core/cli/mcp/api 四包，共用 schema |

上游展示的调用时延、通过率和上下文节省，只是作者的任务集结果，不是本工具的承诺；不将它们写成预算或 SLO。

## 3. 公开来源索引

以下链接均为官方文档、维护者源代码或发布元数据。设计文件中的 `[Sx]` 指向本节。

### S1：上游项目概览、设计与许可

```text
https://github.com/Ying-Kai-Liao/jev-browser
https://github.com/Ying-Kai-Liao/jev-browser/blob/e35ab134f65033d29c528132d92bf06e8d6adcb5/README.md
https://github.com/Ying-Kai-Liao/jev-browser/blob/e35ab134f65033d29c528132d92bf06e8d6adcb5/NOTES.md
https://github.com/Ying-Kai-Liao/jev-browser/blob/e35ab134f65033d29c528132d92bf06e8d6adcb5/LICENSE
```

依据：目标拆分、局部判断、上游限制和许可证标注。设计采取其分工思想，而不是照搬声称的性能。若以后移植代码，保留其许可与版权通知；本次没有移植运行代码。

### S2：上游会话、Jev 客户端和流程执行源码

```text
https://github.com/Ying-Kai-Liao/jev-browser/blob/e35ab134f65033d29c528132d92bf06e8d6adcb5/src/session.mjs
https://github.com/Ying-Kai-Liao/jev-browser/blob/e35ab134f65033d29c528132d92bf06e8d6adcb5/src/jev.mjs
https://github.com/Ying-Kai-Liao/jev-browser/blob/e35ab134f65033d29c528132d92bf06e8d6adcb5/src/flow.mjs
```

依据：`launch`、构造函数监听器、`close` 和流程顺序调用。即使传入一个已连接 browser，也不能未经改造就认定其会保留默认 context 与所有标签页。

### S3：Chrome 原生授权连接与旧调试参数限制

```text
https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md
https://developer.chrome.com/blog/remote-debugging-port
```

官方 Chrome DevTools MCP 文档介绍：Chrome 144 及以上可在 `chrome://inspect/#remote-debugging` 开启并授权现有浏览器的连接；多 profile 下默认连接选择受 Chrome 决定。此文档证明 Chrome 的能力和授权边界，不意味着我们要依赖该 MCP 服务转发操作。

Chrome 官方 2025-03-17 的说明指出：从 Chrome 136 起，传统 remote-debugging-port/pipe 参数不能针对默认用户数据目录生效，需要非标准 user-data-dir。它与上述用户授权机制是不同路径；不能据旧命令行方式承诺无条件接管主 profile。

### S4：Playwright CDP 与默认 context 设置

```text
https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsertype.md
```

依据：CDP 连接默认 context、仅支持 Chromium 系列、相对 Playwright 协议保真度较低，以及 `noDefaults`（1.60 加入）可避免部分默认覆盖。不是所有高级能力都与管理浏览器相同，因此需要 capability 检查。headless 是 launch 设置，不是 attach 后的运行时切换。

### S5：Playwright 固定版本的 channel 发现与断开实现

```text
https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/chromium.ts
```

依据：`_connectOverCDPInternal` 识别 channel；`resolveChannelEndpoint` 从默认用户目录的 DevToolsActivePort 构造连接；CDP 路径的关闭回调用于 transport 清理。此项是版本固定的源码证据，不是对未来版本或每个平台的保证；实现不得 import 私有模块。尤其需要端到端测试上层 API 的清理是否保留实际进程和页面。

### S6：Playwright 发布元数据

```text
https://registry.npmjs.org/playwright/latest
```

核对时该端点返回 Playwright `1.63.0`，Node engine 为 `>=20`。本方案拟用 Node 24.x 并锁 Playwright 1.63.0 进行 P0/P1 验证；这是候选基线，不要求把仓库其他工具的 Node >=18 改掉。开发开始时再次检查并固定实际依赖，不把 latest 作为可复现版本。

### S7：TypeSafe JavaScript SDK 与客户端配置

```text
https://docs.typesafe.ai/llms.txt
https://docs.typesafe.ai/sdk/javascript.md
https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient.md
https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md
```

依据：官方 `@typesafe-ai/sdk`、Node 20+、TypeSafeClient、API key/model 环境变量及注入 logger/fetch/timeout/retry 的接口。SDK 每次尝试的超时不是总任务 deadline；debug body 默认脱敏不足以保护页面敏感内容，须由本工具约束日志。

### S8：TypeSafe API、Choice 和 Noul

```text
https://docs.typesafe.ai/api.md
https://docs.typesafe.ai/primitives/choice.md
https://docs.typesafe.ai/primitives/noul.md
```

依据：`/v1/systemone` 的 state/questions/answers、Choice 255 项限制、分项概率、Noul yes 概率、返回模型和 usage、认证/限流等错误。接口有类型不等于判断内容一定正确。

### S9：TypeSafe 构建指南与 fan-out / function calling

```text
https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
https://docs.typesafe.ai/patterns/fan-out.md
https://docs.typesafe.ai/cookbooks/function_calling.md
```

依据：代码掌握流程、从闭集选参数、同一状态多个独立问题并行；不把原语当自由文本生成器。并行问题彼此不知道答案，依赖后续观察的问题另起请求；追加问题仍有输入用量，需要实测。

### S10：TypeSafe confidence

```text
https://docs.typesafe.ai/confidence.md
```

依据：Choice/Score confidence 汇总分布形状，Noul 不带同样的 confidence；门槛要按业务风险与数据校准。设计中的“理解有 95% 信心”也不是模型 API 值，更不是浏览器成功率。

### S11：Playwright 等待与断言

```text
https://playwright.dev/docs/actionability
https://playwright.dev/docs/api/class-page#page-wait-for-load-state
```

依据：操作前的 actionability 自动检查与明确断言；文档不推荐以 networkidle 作为测试就绪判断。采用局部事件/断言不是无等待，而是避免全局固定等待带来的无效耗时。

### S12：Playwright 原生对话框

复核状态：新增审查依据，本轮固定版本文档请求超时；实现前须重新联网核对和实测，不视为已验证的本机行为。

```text
https://playwright.dev/docs/dialogs
https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/dialogs.md
```

依据：页面触发 dialog 后，如果没有 listener，Playwright 会自动 dismiss；注册 listener 后，调用方必须 accept 或 dismiss，否则页面动作可能停住。该行为是 page 级的，因此不能假设只操作一个选中页就完全不影响同一 context 的其他页。P0 需要用两个标签页和可控测试页面验证实际 CDP 接管行为；未验证前不把“默认 dialog 策略”列为稳定能力。

### S13：Playwright 下载生命周期

复核状态：新增审查依据，本轮网络请求超时；实现前须重新联网核对固定版本，并测试 attach 模式的实际能力。

```text
https://playwright.dev/docs/downloads
https://playwright.dev/docs/api/class-download
```

依据：下载对象需要在下载事件期间或之后保存到指定路径；上下文关闭时临时下载目录可能被清理，调用方不能把临时路径直接当长期 artifact。设计采用任务专属目录、`saveAs`、artifactId 和鉴权取回；接管日常 Chrome 的默认下载目录不在工具控制范围内，硬配额和可靠文件关联必须通过能力测试后才开放。

## 4. 风险、假设与验证责任

| 项目 | 当前认识 | 验证 / 处置 |
| --- | --- | --- |
| 日常 Chrome 能否授权接管 | 官方路径存在，但未检查本机版本/策略 | P0；失败不静默换实例 |
| channel 端点发现 | 固定版本实现支持；公开参数说明主要写 URL | P0/P1 契约测试与显式已授权端点备用 |
| 多 profile / WSL | 默认 profile 与跨环境路径存在差异 | P0 记录支持范围；不宣称自动全兼容 |
| CDP 高级能力 | 不等同原生 Playwright 协议 | capability 探测，unsupported 明确返回 |
| 接管中的下载 | 保留浏览器设置与下载路径控制有冲突 | P0 验证；无可靠文件证据不能报导出成功 |
| 人工同时操作 | 无法真正锁住用户和其他软件 | 漂移检测、页面选择、串行任务、暂停 |
| 未知网页副作用 | 概率分类不能保证看穿业务含义 | 默认保守确认、scope、测试；不承诺绝对识别 |
| 云模型隐私 | 页面摘要会发到服务端 | 域许可、数据外发同意、secret 本地化、禁传域 |
| 规划服务 | 用户未指定厂商、模型、预算 | Provider 抽象；实现前选可用服务；不影响 execute |
| 性能 | 减少重复规划/往返合理，不代表已达到最高速度 | P6 冷/暖、A/B、成功率和副作用标准一致的测试 |
| 工期 | 旧版 15—23 人日估算已撤销 | P0 后按兼容风险和首个 Provider 重估，非日期承诺 |
| 任意网站支持 | 没有通用成功保证 | 首版覆盖明示能力、明确失败与人工接管 |

## 5. 自审结论

已经核对“用户需求 → 技术决策 → 开发阶段 → 验收门槛”的对应关系，并区分三类内容：

1. **已确认需求**：多入口、A/B 共用、默认日常 Chrome/有头、可配置替代方式。
2. **资料支持的事实**：上游分工/生命周期、Chrome 授权机制、CDP 限制、TypeSafe 契约。
3. **待验证设计**：本机连接、具体模型 Provider、下载兼容、性能与成功率。

用户已明确“方案 99% 把握”的验收标准：指**方案本身的完整性、可实现性与内部一致性**，不包含本机 Chrome 实测、下载/弹窗兼容性和实际成功率；后者仍由 P0—P6 验证门槛负责。按该标准：需求逐项映射、状态机/预算/审批竞态、配置冲突、来源核对与三轮回读修正均已完成且无已知矛盾，达到 99% 的主观信心；未实测事项没有被写成成功结论，下一步必须从 P0 开始。

本次校验边界：已通过四份文档的代码围栏闭合、JSON 示例语法、本地相对链接存在性、独立来源编号与关键字段检查；没有可运行 schema，不能把这些检查称作接口测试。新增 S12/S13 及在线链接多轮尝试均超时，保持待复核。已建立新基线（36 个受管文件）并完成比对：此后仅 DESIGN.md 的本轮两处小修，其余文件字节级未变；两个上层索引相对 git HEAD 的差异仅为规划入口（忽略行尾），CRLF 空白提示未通过全文件重写来消除。没有运行浏览器 smoke、模型调用、安装或构建。

## 6. v0.2 审查与修正

| 严重性 | 原问题 | 修正与对应验收 |
| --- | --- | --- |
| 高 | 超时/取消被当成网页动作已停止，可能重放副作用 | cancelling 收尾、动作账本、unknown 隔离，P2/P5 崩溃与超时测试 |
| 高 | 暂停只占页不足以保护共享登录态，断开又与恢复规则冲突 | profile 级预约、显式 detach、锁先于页面复核，P2/P5 |
| 高 | 模型可以生成较容易的验收条件并自证成功 | 调用方 successCriteria、总目标验证、逐项未完成记录，P4 |
| 高 | approve/resume 的 revision 变化使授权失效或重复消费 | requestId 幂等、actionRevision、派发前原子消费，P5 |
| 高 | 下载返回临时路径；接管可能干预其他页原生 dialog | saveAs/artifact 契约，未选中页非干扰作为 P0 门槛，仍待实测 |
| 中 | 保留原配置时无法只靠环境变量切换引擎/显示模式 | attach/launch 分支配置、独立 profile，P1 配置矩阵 |
| 中 | 原生审批被错误等同为同用户可执行的 CLI | 明确独立签发边界；首版危险操作只暂停，不强行实现通用审批 |
| 中 | 工期、付费测试次数与首版范围低估 | 撤销旧工期，先小样本后授权扩样，高级能力后置 |

修正后的架构仍是 A/B 共用执行引擎，没有改变默认日常 Chrome、有头和三入口需求；修复的是可实现性、安全和验证边界。P0 未通过前，默认 CDP 路径仍是候选，不是已经批准上线的实现。
