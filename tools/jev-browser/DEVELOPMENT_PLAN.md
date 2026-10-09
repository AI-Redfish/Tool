# jev-browser 开发计划与验收

> 方案版本：v0.2；复核日期：2026-09-24。状态：**核心已实现（v0.1 实现轮）**：P1/P2/P3 的离线能力与 P5 的进程/审批/恢复机制已按本计划落地，50 个离线单元/集成测试通过（假件驱动，无浏览器、无模型 key）；**P0 实机验证未执行**，所有涉及真实 Chrome、真实模型与性能的验收项仍未完成。
> 前置设计：[DESIGN.md](DESIGN.md)。资料与未决项：[RESEARCH.md](RESEARCH.md)。

## 1. 推进原则

1. 先证明“接管真实 Chrome 且不破坏会话”，再投入完整实现。（实现轮已按此约束：引擎先行完成，但 P0 未通过前不宣称默认接管已支持）
2. 先完成共用执行能力（A），再接入可选规划器（B）；不为 B 另建浏览器循环。
3. CLI/MCP/API 共用 schema、状态、错误与策略；使用协议契约测试防止适配器漂移。
4. 所有测试优先使用本地 fixture、测试账号和隔离 profile。日常主 profile 只做经用户明确允许的最小只读验证。
5. 所有性能结论都带版本、任务集、成功率、计时边界；不得引用上游成绩作为本工具成绩。
6. 按阶段退出门槛推进，不因赶时间省掉副作用确认、验证或隐私保护。

## 2. 里程碑和依赖

```text
P0 接管/保护性验证
  ↓
P1 工作区与契约
  ↓
P2 确定性执行与浏览器生命周期
  ↓
P3 Jev 局部执行
  ├→ P4 可选规划器
  └→ P5 长驻服务与三入口闭环
           ↓（P4/P5 汇合）
P6 安全、基准与发布准备
```

旧版 15—23 人日仅是未验证的初步估算，未充分包含跨进程锁、崩溃恢复、独立审批、CDP 非干扰验证，本轮撤销该总工期作为排期依据。P0 后按兼容结果和首个规划 Provider 再估，不给未经验证的交付日期。

先交付三入口下的同一条只读流程与一条下载流程，保留 A/B 双模式；高级分支嵌套、跨 profile 并行、事件流、跨宿主迁移延后。P0 可在独立临时目录安装锁定依赖和运行最小原型，不依赖 P1 正式包结构，避免“先验证还是先构建”的循环依赖。P1 提供协议骨架，P2/P3 打通 execute，P4 打通 run，P5 做生命周期/恢复/审批联调，P6 才发布。

## 3. P0：接管可行性与保护性验证（阻塞门）

> 进度（2026-09-27 实现轮）：**launch 路径已完成实机冒烟并通过**（`scripts/smoke.mjs`，结果见
> [docs/compatibility.md](docs/compatibility.md)）；attach 路径待用户在 Chrome 原生授权后专项验证。

### 工作项

- [ ] 记录 Windows/Chrome/Node/Playwright 版本、Chrome profile 类型、是否受企业策略管理；不采集浏览历史或 Cookie。
- [ ] 在测试 profile 检查原生授权远程调试与固定版本 `connectOverCDP("chrome")`；验证显式已授权 endpoint 备用路径。
- [ ] 对 Chrome 未运行、未开启授权、拒绝授权、授权超时、多个 profile、端点失效分别生成可操作诊断。
- [ ] 用已有默认 context 验证页面枚举、目标页选择、只读内容获取和登录态可见；证明未创建隔离 context 冒充原会话。
- [x] 在本地 fixture 验证导航、输入、popup、dialog、iframe、Shadow DOM、上传与下载 capability。（部分：navigate/提取/断言/下载/截图已由 smoke 实测；popup/dialog/iframe/Shadow DOM/upload 待补）
- [ ] 检查 `noDefaults: true` 对焦点、媒体、下载行为的影响；记录不能支持的能力。
- [ ] 未选中测试页弹出 alert/confirm/prompt/beforeunload 时，验证工具不会自动替用户处理，原生人工操作仍可用；不能凭 noDefaults 推断。
- [ ] 验证 download 事件、saveAs、context 关闭/连接断开后 artifact 完整性；不扫描真实下载目录。
- [x] 验证 launch 的按 engine 独立 profile、沙箱和子进程环境白名单，不把模型/审批密钥传入浏览器。（部分：独立临时 profile + chromiumSandbox 已实测；子进程环境白名单待补）
- [ ] 测试正常 disconnect、异常中断、SIGINT、模型错误后的清理；日常进程、既有页和 profile 保留。
- [ ] 对比 connect 与 reconnect 的授权交互，确认能否在长连接内复用，不承诺永不弹确认。
- [ ] 验证任务中途 Chrome 被关闭/崩溃/调试授权撤销时的断连处理：停止外发、任务转 paused/interrupted、artifact 完整性、不自动重启替代浏览器。
- [ ] 原生 Windows 作为主路径；WSL 只记录为独立环境，不能未经测试宣称通用。

### 交付物

- [x] `docs/compatibility.md`（实现阶段新增）：确切版本、测试步骤、结果、限制、敏感信息已剔除的诊断。（2026-09-27 交付）
- [x] 最小 smoke 测试脚本，默认仅操作本地 fixture，不自动接管日常 profile。（`scripts/smoke.mjs`，npm run smoke）
- [x] 连接、清理、页面选择和下载能力的 go/no-go 结论。（launch=go；attach=待验证）

### 退出门槛

1. 默认接管路径在专用 Windows 测试用户的默认 Chrome profile 上重复至少 10 次连接/只读观察/断开，覆盖多页和原生对话框；无关闭 Chrome、无清空登录态、无误关页、无未授权 dialog 处理。非默认测试 profile 使用显式端点，不拿它的结果替代 channel 默认目录发现测试。用户日常 profile 的最小只读验收另行授权。
2. 授权失败明确报错；无绕过、无静默切换成隔离浏览器。
3. 若默认接管不能成立，停止将其称作已支持；报告约束，再由用户选择升级 Chrome、显式端点或另行评估扩展方案。不得私自把需求改成“新启动 Chrome”。

## 4. P1：工作区、配置和契约

### 工作项

- [ ] 按本仓库布局搭建 `core/cli/mcp/api`、工程引用、脚本、私有包依赖和 pnpm 锁文件。
- [ ] 锁定可通过 P0 的 Playwright 和 SDK 版本；明确本工具 Node 版本，不全仓升级依赖。
- [ ] 定义 ToolRegistry、输入/输出 schema、错误码、TaskStatus/pauseReason、session 状态、FlowStep、LocatorSpec、capability 类型。
- [ ] 选定 Windows/Node 可安装的事务存储驱动，定义状态/幂等/审批消费/动作账本事务与升级规则；准备崩溃注入 fake。
- [ ] 明确 allowedOrigins/modelOrigins、session/page 选择、successCriteria、values/secretRef 的三入口契约。
- [ ] 实现纯配置合并与校验；覆盖布尔解析、条件默认、配置来源、启动器改变 cwd 时的绝对路径要求和敏感信息脱敏。
- [ ] 实现 `doctor`，区分“只检查配置”与“经用户同意尝试连接”；不会自行变更 Chrome 设置。
- [ ] 准备 Clock/Judge/Planner/Browser fake，保证多数单元测试无需网络、模型 key 或浏览器。
- [ ] 明确 stderr 日志、CLI JSON 和 MCP stdout 边界；第三方 SDK logger 也通过适配层注入。

### 退出门槛

- pnpm 与 npm 两条全新安装/构建路径通过；`node bin/tool-launcher.js build jev-browser` 构建成功。
- 配置默认是 attach/chrome/headless=false；`attach+headless=true`、无效布尔、非法路径与未知字段拒绝。保留 attach 子配置时仅改环境变量即可切到 launch/chromium/headless，不需删文件字段。
- 缺少 planner key 不阻止 execute；缺少 Jev key 不阻止确定性步骤；doctor 不初始化付费服务。
- 三个适配器使用同一份工具与 schema；根启动器无业务逻辑扩张。
- 构建测试不自动连接用户 Chrome，不自动下载浏览器；管理 Chromium 的 setup 独立。

## 5. P2：确定性执行器、session 和流程（A 的基础）

### 工作项

- [ ] 实现 attach/launch 连接器与 borrowed/owned 生命周期；默认不开新 context、不覆盖用户页面。
- [ ] 页面路由、origin scope、profile 租约、超时/取消和并发排队。
- [ ] action/assert/extract、简单 branch/有界 forEach 的白名单实现，输入唯一性、流程版本、实际展开步骤计数；跨页迭代不保留过期 elementId。
- [ ] locator 自动等待、事件等待、明确 expect；避免统一 sleep/networkidle。
- [ ] 导航、点击、输入、选择、滚动、截图；按 P0 capability 逐步接入 upload/download/dialog。
- [ ] 任务状态、checkpoint、prepared/in_flight/verified/unknown 动作账本和基础 PolicyGate；排队、执行、暂停均累计计时，恢复不重置，绝对 deadline 到期收尾。
- [ ] 超时/取消不立刻让出 profile；确认在途操作 settle 或隔离后才发终态，无法确定时不再写入。
- [ ] profile 级预约、平台用户级锁目录、规范化实例身份与宿主引用计数，多个 dataDir 也不能重入同一浏览器。
- [ ] CLI `execute` 运行完整 flow；MCP 单次 action/execute 注册，HTTP 契约可先以测试适配器验证。

### 退出门槛

- 确定性流程在没有 Jev/规划 key 时正常工作，模型调用数严格为 0。
- 成功前必须验证步骤 expect 与适用的总任务验收；失败/暂停不包装为 done。空计划、部分条目失败、未处理完的集合不能通过“所有已执行步骤成功”误报任务完成。
- 每个退出路径都遵守所有权，取消不杀日常 Chrome。
- 连续步骤只建立一次 session；重复任务提交不会重复排队，同键不同参数冲突。
- 非幂等动作超时先查证，不盲目重放；跨任务不能读取别人的 session/artifact。

## 6. P3：Jev 页面语义判断和局部循环

### 工作项

- [ ] 官方 SDK 窄适配，统一总预算、超时、取消、重试和日志；记录服务返回 model 和 usage。
- [ ] 页面/frames 观察、开放 Shadow DOM、标签与上下文、遮挡、状态差量、secret 脱敏。
- [ ] 快照和 elementId 版本检查；过期候选、目标不在候选中时暂停/扩展观察。
- [ ] 独立问题 fan-out；条件问题显式前提，跨参数一致性校验。
- [ ] 超大候选分层选择，每题含 no-match 且不超过服务限制。
- [ ] 单 goal 多动作，维护完成/失败/歧义/登录/确认/无进展状态；不把复杂目标全交给 Jev。
- [ ] 将来源错误、模型判断错误、动作执行错误和证据不足分类记录。
- [ ] 在标注 fixture 上校准门槛；验证集与调参集分离。

### 退出门槛

- 已知定位器保持零模型路径；只有语义步骤调用 Jev。
- `paused + likely_done/ambiguous` 和 no-match 不继续写操作；后置状态不足不报 done。
- passwords/API keys/cookies/secret values 不进入捕获的 SDK 请求体或日志。
- 所有 schema/fan-out/边界测试离线通过；少量显式启用的真实 API 测试独立计费。
- 上游局限场景（有序子目标、计数、排序）通过拆分或代码断言处理，不套用上游阈值保证成功。

## 7. P4：可选规划器与自主任务（B）

### 工作项

- [ ] 确定首个用户可配置的 PlannerProvider，并在实现前阅读其实际协议；不硬编码未知厂商 key/model。
- [ ] `run` → 验收条件校验 → 短计划 → 共用 FlowExecutor；模型输出只能为经 schema 校验的步骤。缺少 successCriteria 时先补充，不让规划器生成一个容易的标准来自证成功。
- [ ] 缺信息、缺权限和缺规划器分别返回可诊断状态/错误，不自行补造。
- [ ] 仅在必要时重规划，保留已完成步骤、副作用记录与授权边界。
- [ ] 限制重规划次数、上下文/token/请求总预算；一次受控输出修正。
- [ ] 网页提示注入测试：无法诱使规划器读取文件、越域、换 endpoint 或放宽审批。

### 退出门槛

- 同一完整目标可由 CLI/API 无外部 Agent 地规划并执行；不等于让 Jev 生成计划。
- `execute` 路径没有 planner 调用、也不要求 planner key。
- 任务阶段只有一个规划负责人；出现未知结果的写操作时不从头执行。
- 规划器不可绕过 execute/act 已有的策略；缺模型配置快速失败而非无限重试。

## 8. P5：三入口、长驻复用和人工闭环

### 工作项

- [ ] MCP tool 注册、进度和长任务轮询，stdin/stdout 纯协议测试。
- [ ] CLI 人类可读/JSON 模式、退出码、session 选择和任务 query/cancel/resume/approve。
- [ ] HTTP session/task 路由、202 契约、查询和可选事件流；loopback + token + Host/Origin 检查。
- [ ] 实现显式长驻共享模式：CLI/MCP 可以连接本地 API，避免每条命令重连 Chrome。
- [ ] 编排 session/profile 租约、跨进程冲突、队列、公平取消和 disconnect 清理。
- [ ] one-shot CLI 暂停选择同进程等待，或存 checkpoint/任务级预约后断开退出；恢复重新建 session/选页/补敏感变量，无法重建状态时保持待处理。
- [ ] cancel/resume/approve 的 expectedRevision 冲突、重复调用、过期 grant、幂等记录原子提交；prepared 后崩溃/in_flight 超时不得自动重放。
- [ ] session disconnect 遇 running/queued/cancelling 拒绝；paused 仅显式 detachTask 才允许断开并保留预约/审批需求。最后引用才断共享连接，API 请求连接中断不自动 cancel。
- [ ] 确认 token 单次消费、短有效期、动作/参数/页面指纹绑定；拒绝重放和跨主体使用。
- [ ] 独立可信确认通道的签发端使用 Agent 不持有的凭据/用户在场验证；同 OS 用户可任意调用的裸 CLI 不算隔离。approve 只消费 grant，缺可信签发端则受限预授权或暂停。
- [ ] HTTP 幂等记录使用 endpoint + key 索引，并原子保存请求体摘要与 taskId；覆盖同键不同输入、进程重启和过期情况。
- [ ] 验证 requestId 重试先于 expectedRevision 校验，grant 绑定 actionRevision，派发前才原子消费；取消/过期/重启不能释放 unknown 动作的隔离记录。

审批签发通道可作为后续受控写操作里程碑，不阻塞首版只读/下载交付；未通过独立审批验收前，高风险动作始终暂停，不以假 grant 或执行 Agent 自批替代。

### 退出门槛

- 三个入口对同一 fixture 返回相同业务状态、错误和证据。
- 不交互的 Agent/API 遇到需人工处理的状态时明确暂停，不替用户自动批准；Agent 自行调用 approve 或提交 `approved: true` 不能获得授权。
- token 认证、跨任务访问、防路径遍历、请求体限额、Origin/Host、日志脱敏测试全部通过。
- 一个日常 profile 默认仅一个活动任务；paused 也预约整个 profile，人工干预后重验。心跳过期但原宿主仍活着不能抢锁，localhost/127.0.0.1/不同 dataDir 不会绕过同实例互斥。
- 任务终态、过期、未知结果可明确区分；崩溃恢复不自动执行，secret 不落盘，过期 artifact 不影响用户另存的文件。
- 多步暖执行中不每步创建 browser/context/CDP 连接。

## 9. P6：安全回归、性能实验和发布准备

### 测试分层

| 层级 | 覆盖 | 运行方式 |
| --- | --- | --- |
| 单元 | 配置/阈值/状态机/预算/差量/schema/策略 | 默认 CI；无浏览器、无 key |
| fixture 集成 | 表单、SPA、计数、排序、重复按钮、iframe、Shadow DOM、对话框、下载 | 本地或 CI 的管理 Chromium |
| 接管兼容 | 原生授权、页选择、登录态、断开保护、人工干预、多 profile | 专用 Windows 测试环境；日常 profile 需单独授权 |
| 真实模型 | Jev/规划器响应、重试和成本、语义准确性 | 显式凭据、独立预算；不混入普通安装/构建 |
| 协议契约 | CLI/MCP/HTTP 业务一致、stdout 纯净、幂等和权限 | 本地 fixture + fake provider |
| 安全 | 页面注入、凭据泄露、过期快照/授权、越域、非幂等超时、取消恢复 | 每次候选发布必跑 |

### 浏览器和配置矩阵

必须覆盖：

1. 默认 attach Chrome + 有头 + 当前 session；授权/拒绝/撤销/超时。
2. launch 本机 Chrome：有头/无头，独立持久化目录，目录占用。
3. launch 管理 Chromium：有头/无头，未安装浏览器、安装后重试。
4. 配置文件与环境变量分别切换；优先级冲突、布尔 false、条件默认。
5. Chrome 未启动、端点不可达、现有 tab 已关闭、用户自行导航/切账号。
6. Windows 主路径；不支持的平台/跨 WSL 行为明确标注，不填“测试通过”。

### A/B 公平性能实验

至少定义三组可重置任务：

- **F 固定流程**：调用方已经提供步骤；A 与 B 的执行引擎对照，明确不把手工准备步骤时间伪装为零规划。
- **S 单一语义目标**：例如在变化的表单中填指定字段，比较局部循环和批量判断。
- **D 动态复杂目标**：分页筛选、下载并处理异常分支，分别由外部 Agent（A）与内部同等级规划器（B）完成。

分两层实验，避免首轮就产生大量付费调用：离线回归覆盖全部 fixture；真实模型先每组 3 个代表任务、每种模式 3 次，确认预算与标注可靠后，再经用户批准扩展到每组至少 10 个任务、每种模式每任务至少 10 次。完整 A/B 至少 600 次任务运行（30×10×2），不是“总共300次”；先估算调用/token，预算耗尽中止并如实报告不完整样本。

A/B 按相同任务配对、随机化次序，固定设备/浏览器/站点 fixture/模型实际版本/成功与授权标准。只有模型支持的生成参数才配置，不能假定 Jev 和通用规划器有同一 temperature 接口。F 组分别报告已有步骤执行开销和从目标开始规划的端到端开销，不把已给计划与未给计划混为等价输入。S 组聚焦局部循环消融，不强行为所有任务套上完整 B 规划。D 组使用同等级规划器、相同观察和成功条件。

重复运行不是独立新任务；按任务分层报告成功率和配对时延差异。每任务 10 次不用于宣称可靠 p95；p95 样本不足标探索性并列出样本量。失败/暂停/预算耗尽均保留，另报成功完成耗时分布，防止“更快失败”被认作提速。

分别报告：

- 从同一个任务输入到验证完成的总耗时，A 包含外部 Agent 的规划和轮次；冷连接与暖连接分开。
- 含人工等待 / 扣除人工等待两套数据；不可扣掉真实模型、页面等待或失败重试。
- 成功率、误报 done、暂停/失败/重试率、median/p95、planner/Jev 请求与 token、连接次数、观察数据量。
- 失败任务同样进入总体结果；不能只算成功样本后宣称更快。
- SDK/模型价格如有可靠来源再折算成本，否则只报告 usage，不写虚假美元数。

发布门槛（对测试集的验收目标，不是对所有网站的保证）：

- 已选 fixture 安全与确定性用例全部通过；0 次关闭借用浏览器/误关既有页/凭据泄露/未授权危险动作。
- 已授权可完成的标注语义任务以观测成功率 ≥95% 为工程目标，误报 done 为 0；不等于对真实网站有95%的统计保证。必须报告任务数、重复数、范围与不确定性；验证码/禁止动作测试单独按正确拒绝评估，不混入可完成任务分母，也不计作业务成功。
- 纯确定性 execute 的 Jev/planner 请求严格为 0；语义 execute 的 planner 请求严格为 0。
- 优化版相对同成功标准基线不能靠降低安全/验证提速；如未有显著优势，如实报告，不宣称“最高效率”。
- P0 接管/清理矩阵再次通过，CLI/MCP/API 契约一致；所有阻塞级安全与数据损坏风险关闭。

## 10. 最终交付清单（实现阶段）

- [ ] 可构建的四包工作区、锁文件、准确 engines 和许可说明。
- [ ] 默认接管、显式 launch Chrome/Chromium、headless 配置和 doctor。
- [ ] A/B 共用引擎，三入口、任务查询/取消/确认/恢复、日志与度量。
- [ ] 无敏感信息的配置/流程/MCP/HTTP 示例；默认 Chrome 无需先下载 Chromium。
- [ ] `.gitignore` 排除 `.env`、profile、tokens、downloads、截图/trace、临时运行状态；不覆盖现有规则。
- [ ] API/CLI 使用说明、兼容性矩阵、故障诊断、权限与云模型数据外发说明；含 task/session 状态机、artifact 取回、数据保留和审批威胁边界。
- [ ] 自动化测试、性能报告与原始脱敏数据、上游归属说明（若有代码移植）。
- [ ] 实现通过后才更新根 README 的“可用工具”表；规划阶段只加“规划中”入口。

## 11. 本次文档交付自审

- [x] 已确认两种执行模式及 Agent/CLI/API 共用，不再重复询问相同选择。
- [x] 已读取仓库规范、启动器及现有 core 示例；保留现有未提交修改。
- [x] 已区分接管/启动、有头/无头、Chrome/管理 Chromium。
- [x] 已核对上游生命周期差异和 Chrome/CDP 官方边界，接管验证前置。
- [x] 已加入所有权、隐私、安全、非幂等重试、预算、并发和恢复要求。
- [x] 已把命令/schema 标为拟议，没有把规划目录伪装成可运行工具。
- [x] 已将真实电脑兼容性、规划模型选择、真实速度与成功率标为待验证。
- [x] 第二轮回读后修正幂等索引、启动器路径、动作后置条件、暂停预算与独立审批边界。
- [x] 已回读四份规划文件与两个索引，人工检查相互引用和 JSON 示例。
- [x] 本轮命令行恢复后，通过四份文档的代码围栏闭合、JSON 语法、相对链接目标、独立来源编号和关键字段检查；这是结构检查，不是运行 schema 测试。
- [x] git 范围检查确认规划目录仍只有四份 Markdown，无包配置或运行入口；两个上层索引忽略行尾后的差异仅为规划入口。
- [x] 全仓基线哈希比对：review-v03 基线（36 个受管文件）比对通过，此后仅 DESIGN.md 本轮两处小修，其余文件字节级未变。
- [ ] 外部链接在线可达性与新增 S12/S13 的固定版本复核：多轮请求均超时，保持待联网复核；实现前必须先完成。

上述勾选只表示文档设计覆盖与结构校验，不表示实现、浏览器实测或模型测试已完成。本轮只修改四份规划文档，未修改运行代码或安装依赖。git diff --check 在两个已有索引报告 CRLF 行尾空白，未做全文件换行转换；规划文档另行检查空白。用户确认“方案 99%”指方案本身的完整性/可实现性/一致性；本机接管、弹窗/下载兼容性与实际性能仍属 P0—P6 验证范围，不在此承诺内。
