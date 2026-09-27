# jev-desktop 开发计划与验收

> 方案版本：v0.1；复核日期：2026-09-24。**状态更新（实现阶段）：P1–P5 核心功能已实现并通过本地端到端验证（含 mock 规划器/Jev 联调、真实窗口 UIA 快照与语义动作、SendInput 中文输入、剪贴板、截图、MCP 协议）；P0 六应用实测矩阵与 P6 基准/发布项仍按本计划推进。**
> 复验（2026-09-27）：离线测试 30/30、doctor、真实窗口只读快照/execute 全链路、JevClient 真实 HTTP（mock）、MCP 握手重跑全绿；修复 `cli.py --help` 崩溃；明细见 [README.md](README.md) 实机验证记录。
> 前置设计：[DESIGN.md](DESIGN.md)。资料与未决项：[RESEARCH.md](RESEARCH.md)。

## 1. 推进原则

1. 先用真实目标应用证明"观察得到、操作得动"，再投入完整实现（P0 阻塞门）。
2. 先完成共用观察/动作能力与 `execute`，再接入 Jev 与 `run` 的规划器；不为 run 另建执行循环。
3. CLI/MCP 共用 `TOOLS` 元数据、schema、状态与错误码；适配器只做转发。
4. 测试优先使用本地 fixture（记事本、自建 WinForms 测试窗体）；不拿用户日常登录态应用当回归靶子。
5. 所有性能结论带版本、任务集、计时边界；不引用参考项目成绩作为本工具承诺。
6. 按阶段退出门槛推进；选型未锁定不开始 P1 包骨架。

## 2. 里程碑与依赖

```text
P0 选型与目标应用验证（阻塞门）
  ↓
P1 包骨架与契约（launcher.json + requirements + TOOLS + config + refs）
  ↓
P2 观察通道（uia 快照/骨架 → 截图 → OCR → vlm）
  ↓
P3 动作通道 + execute 引擎（SendInput / UIA Pattern / 窗口管理 / 账本）
  ├→ P4 Jev 集成（Choice/Noul、候选分组、置信路由）
  └→ （P4 完成后）P5 run 规划器 + doctor + 双入口打磨
           ↓
P6 基准、文档与发布准备
```

## 3. P0：选型验证与目标应用实测（阻塞门）

### 工作项

- [ ] 记录 Windows 版本/Python 版本/DPI 缩放/显示器拓扑；记录 `PER_MONITOR_AWARE_V2` 设置后 UIA 矩形、mss 截图、SendInput 坐标三方一致性（125%/150% 混合缩放各测一轮）。
- [ ] **uiautomation vs pywinauto 对比矩阵**：记事本、Chrome、Office（Word 或 Excel）、VS Code（Electron）、微信、钉钉——各测：树可读性（深度/元素数/耗时）、交互元素识别、Invoke/SetValue 成功率、中文文本输入。
- [ ] **UIA 卡死风险**：对无响应窗口（挂起进程 fixture）做树遍历，验证 `uiautomation` 全局搜索超时（`SetGlobalSearchTimeout`）与单调用超时保护的有效性；确定 IsHungAppWindow 预检是否必要。
- [ ] **COM 线程模型**：验证专用 UIA 工作线程 + 队列串行化方案（STA 初始化、跨线程句柄传递）；确认 FastMCP 线程池 worker 经队列调用可行。
- [ ] **rapidocr v3 实测**：中文截图识别准确率（清晰小字号 12px+）、单帧耗时（冷/热）、内存占用；确认 Python 3.10–3.12 安装无障碍。
- [ ] **typesafe-sdk 连通**：`TypeSafeClient.system_one` 用用户 key 跑通 Choice/Noul；验证自定义 baseUrl 是否可指向博查/Zen（协议同构），不行则落薄 httpx 适配。
- [ ] **规划器 JSON 输出实测**：用户配置的模型上验证 `response_format: json_object` 支持度与 FlowStep 校验通过率。
- [ ] **Electron 无障碍**：验证 UIA 客户端连接后 VS Code 是否自动暴露完整树（Chromium a11y 激活）。
- [ ] **UIPI 实测**：非管理员进程操作管理员记事本，确认失败形态并固化 `INPUT_DENIED` 诊断文案。
- [ ] 快照 token 体积实测：常规应用全量 < 2k tokens、骨架 < 500 tokens 的深度/截断参数初调。

### 交付物

- `docs/compatibility.md`（实现阶段新增）：确切版本、测试步骤、结果、限制，脱敏。
- 最小 smoke 脚本（临时目录安装依赖，不污染仓库）。
- go/no-go 结论：UIA 库、OCR 后端、Jev 接入方式（SDK vs 薄适配）。

### 退出门槛

1. 至少 4/6 个目标应用在主选 UIA 库下"树可读 + 语义动作成功"；不达标项明确归因（无障碍树缺失/卡死/权限），并给出 ocr 档兜底验证。
2. 卡死防护在挂起窗口 fixture 上 10/10 次按超时返回，不挂死工具进程。
3. DPI 三方坐标偏差 ≤ 2 物理像素。
4. 选型结论写入 RESEARCH.md；不达标则换备选重测，不得带着"应该没问题"进入 P1。

## 4. P1：包骨架与契约

### 工作项

- [ ] 按 §9 布局搭建 `core/`（纯 Python 包）+ `cli.py` + `mcp_server.py`；`launcher.json`（`python mcp_server.py` + setup 安装 requirements）与 `requirements.txt`（core）/`requirements-ocr.txt`（rapidocr）。
- [ ] `TOOLS` 元数据：八个工具的名称/描述/参数 schema（单一事实来源）；CLI 子命令自动生成；MCP 注册复用。
- [ ] pydantic 配置模型：来源合并（CLI > env > 文件 > 默认）、未知字段报错、布尔解析、脱敏输出。
- [ ] ref 注册表：内存 + 会话文件双写、TTL、活性校验（pid/矩形/指纹）；错误码枚举与 envelope。
- [ ] 专用 UIA 工作线程 + 任务队列骨架；UTF-8 stdout 强制；stderr 日志规范。
- [ ] 依赖注入接缝：Clock/Judge/Observer/Actor fake，多数单测不依赖真桌面与网络。

### 退出门槛

- `npx github:AI-Redfish/Tool jev-desktop` 能拉起 MCP 并通过 `tools/list` 返回八个工具；`cli.py list` 输出一致；无任何真实动作能力（纯契约）。

## 5. P2：观察通道

### 工作项

- [ ] `uia` 快照：紧凑文本渲染、交互元素 ref 分配、深度/数量截断、`--root` 下钻、窗口定位（app/title/pid）与多候选列表。
- [ ] mss 区域截图 + artifact 落盘；`desktop_screenshot` 的 MCP image 内容返回。
- [ ] rapidocr 适配：文字块+中心坐标+置信度、排序、ref 分配；模型懒加载。
- [ ] `vlm` 档：降采样（≤1568px/JPEG q80）、OpenAI 兼容请求、结构化元素解析、回落 planner 端点。
- [ ] `auto` 降级：UIA 可用性探测 → uia；空结果提示显式升档，不静默。

### 退出门槛

- 六应用矩阵中 P0 达标应用快照可读、ref 可解析；token 体积达标；`desktop_snapshot` 三档 + auto 行为符合契约测试。

## 6. P3：动作通道 + execute

### 工作项

- [ ] SendInput 模块：绝对坐标鼠标（click/double/right/hover/drag）、扫描码组合键、`KEYEVENTF_UNICODE` 文本、剪贴板快速通道（恢复原剪贴板）。
- [ ] UIA Pattern 动作：Invoke/Value/Toggle/Selection/ExpandCollapse/Scroll；动作前 ref 活性校验；`STALE_REF` 路径。
- [ ] 窗口管理：launch/close/focus/minimize/maximize/restore/move/resize/list；`SetActive` 前台处理。
- [ ] execute 引擎：TargetSpec/FlowStep 校验、顺序执行、expect 后置条件、`${var}` 白名单插值、预算计数、动作账本 JSONL、`--dry-run`。
- [ ] 取消：CLI SIGINT 协作取消；MCP 断连尽力终止。

### 退出门槛

- fixture 流程（记事本写字保存 / 测试窗体勾选+下拉）在 `execute` 下 10/10 成功且零模型调用；每步账本可回放；STALE_REF 在人为破坏窗口场景正确触发。

## 7. P4：Jev 集成

### 工作项

- [ ] provider 适配：官方 SDK 为主，bocha/zen/custom 同构端点适配（P0 结论定 SDK or httpx）；key 仅经环境变量。
- [ ] Choice 元素定位（候选 ≤200、分组、`no_match`）；置信路由（高→执行，低→重观察/`AMBIGUOUS_TARGET`）。
- [ ] 并行 Noul 步后校验（done/blocked/error）；窗口消歧 Choice。
- [ ] 重试收口（RetryPolicy，429/临时故障按剩余预算）；usage 记录。

### 退出门槛

- 语义目标定位在 fixture 上 top-1 准确率 ≥ 90%（≥50 样本）；无 key 时相关步骤报 `PROVIDER_ERROR`/配置错误，确定性路径完全不受影响。

## 8. P5：run 规划器 + doctor + 双入口打磨

### 工作项

- [ ] 有界 ReAct 循环：观察→规划（1–3 步 JSON，一次修复重试）→执行→校验；预算贯穿；`success_criteria` 代码断言 + Noul 语义断言。
- [ ] `PLANNER_NOT_CONFIGURED` 明确报错；execute 零依赖验证。
- [ ] `doctor`：全项能力探测 + `--with-network` 连通性（脱敏）。
- [ ] CLI `--json`/交互双态；MCP 工具描述打磨；错误码全覆盖。

### 退出门槛

- 三条真实任务（记事本写存、浏览器打开指定设置页、微信搜索并发消息[用户授权账号]）中 ≥2 条 run 全自动完成；失败任务返回可操作错误与证据；全程预算不超。

## 9. P6：基准、文档与发布

### 工作项

- [ ] bench：可重置任务集（fixture 优先）×（execute/run）×（uia/ocr 档），记录成功率/耗时/tokens；不宣称通用成功率。
- [ ] README 定稿（拟议契约 → 实测能力）；RESEARCH/DESIGN 回填实测数据；根索引与 tools/README 更新可用工具表。
- [ ] `pyproject.toml`（`[project.scripts] jev-desktop-cli`）支持 pipx 安装；launcher.json 最终核对（stdout 纪律、cwd、setup 幂等）。
- [ ] 安全姿态 A 的数据边界声明落文档；动作账本留存期与清理说明。

### 退出门槛

- 新用户按 README 从零配置（含 key）到跑通第一条 run ≤ 15 分钟；启动器全程无 stdout 污染；账本/日志无 key、无全文敏感值。
