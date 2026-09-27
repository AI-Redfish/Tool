# jev-desktop 技术设计

> 版本：设计草案 v0.1；核对日期：2026-09-24。**状态更新：本设计已实现（观察/动作/Jev/规划/execute/run/doctor 全链路），实现与草案的差异清单见 [README.md「实现说明」](README.md)。**
> 本文件描述计划实现的能力，不代表已有代码或通过实测的性能。资料编号见 [RESEARCH.md](RESEARCH.md)。

## 1. 需求与成功标准

### 1.1 已确认需求

1. 在本仓库新增一个 Python 工具，遵循现有分层、启动器和日志规范（`core + cli + mcp` + `launcher.json`）。
2. 基于「规划 LLM + Jev 判断」控制 Windows 桌面上的**任意软件**，参考 jev-chat/jev-chat-jarvis 的模型分工与 lahfir/agent-desktop 的交互范式。
3. 不做前台页面；以 MCP（stdio）与 CLI 两种方式提供，所有方式共享同一份 core。
4. Windows 原生优先；工具进程必须运行在 Windows 侧（WSL 内无法访问桌面 UIA 与输入合成）。
5. 用户已拍板三项关键决策：目标应用混合且不可预知（观察通道需混合）、模型供应商可换（全部可配置）、首版无风险门禁（安全姿态 A）。

### 1.2 首版范围

- 观察：UIA 语义树快照（紧凑文本 + ref + 渐进下钻）、mss 截图、rapidocr OCR 文字块、可选 VLM 原图理解。
- 动作：UIA Pattern 语义动作（invoke/set_value/toggle/select/expand/scroll）、SendInput 坐标鼠标与键盘（含 KEYEVENTF_UNICODE 中文输入）、窗口管理（launch/close/focus/move/resize/list）。
- 引擎：`execute`（外部步骤，无内部规划）与 `run`（完整目标，规划 LLM 有界 ReAct）共用执行引擎；预算控制；同步返回。
- 入口：MCP 八个工具、CLI 对应子命令、`doctor` 诊断、会话化 ref 复用。
- 首版不做：HTTP API、任务持久化与崩溃恢复、审批状态机、UAC 提权窗口控制、验证码绕过、批量并行桌面任务、远程访问。

### 1.3 成功标准

- 在 P0 锁定的目标应用集（记事本、Chrome、Office、VS Code、微信、钉钉）上，`uia` 档快照可读、语义动作成功、`ocr` 档可定位可点击。
- `execute` 完成确定性步骤不调用任何模型；`run` 在预算内完成一条含语义目标的真实任务（如"在记事本里写一段话并保存"）。
- 常规应用 `uia` 快照 < 2k tokens，骨架快照 < 500 tokens。
- 所有失败返回可操作错误码与证据，不假装成功。

## 2. 架构决策

### ADR-01：三档可降级观察通道

| 档位 | 实现 | 适用 | 成本 |
| --- | --- | --- | --- |
| `uia`（默认） | UIA 树 → 紧凑文本快照，交互元素带 ref | Win32/WPF/WinForms/Qt/UWP/Electron/Office 等暴露辅助功能树的应用 | 零模型成本 |
| `ocr` | mss 截图 → rapidocr → 文字块（文本+中心坐标+置信度），块带 ref | 自绘界面、游戏 HUD、UIA 树为空/不可用的应用 | 本地推理，约 100–500 ms |
| `vlm` | 截图（≤1568px、JPEG q80）→ OpenAI 兼容多模态模型 → 结构化元素描述+近似坐标 | OCR 也失效的图形界面 | 最贵，显式启用 |

- `observation.level: auto` 时按 目标窗口 → UIA 可用性探测 结果选择 `uia`，不可用落 `ocr`；`ocr` 结果为空且 `vlm` 已配置时返回提示让调用者显式升档，**不静默升档**（费用可见）。
- 三档产出统一为同一快照格式（文本 + `ref` 列表），下游动作与 Jev 判断不感知档位差异。

### ADR-02：模型分工铁律

- 确定性步骤（有 ref/selector/坐标）→ 纯代码执行，零模型调用。
- 语义目标（"找到回复输入框"）→ Jev `Choice` 在候选集上做闭集选择（含 `no_match` 项）。
- 步后校验（完成/阻塞/出错）→ 代码断言优先，语义情形用多个 `Noul` 并行问同一状态。
- 任务拆解 → 规划 LLM（OpenAI 兼容 `/chat/completions`），只输出经 schema 校验的步骤，不生成可执行代码。
- Jev 是判断模型（System One），返回类型化答案与概率，**不承担自由文本生成**；规划是普通文本模型，两者凭据与端点分离配置。

### ADR-03：借鉴 agent-desktop 的 ref 范式，自研实现

agent-desktop 的"快照 + 稳定 ref + 渐进骨架遍历"是当前桌面 Agent 交互的最优实践，但其 **Windows 支持全部为 Planned，当前仅 macOS 可用**，不能直接复用。本工具自研等价机制：

- ref 形如 `@<snapshotId>:eN`（UIA 元素）/ `@<snapshotId>:bN`（OCR 文字块）；
- ref 注册表记录 `{pid, hwnd, RuntimeId 或包围盒, 矩形, 指纹(ControlType+Name+AutomationId+ClassName)}`；
- 动作前重校验：pid 一致 + 矩形漂移 < 阈值 + 指纹匹配，失效即 `STALE_REF` 并附重新观察提示，**绝不盲点旧坐标**；
- 注册表持久化到会话文件，CLI 跨命令与 MCP 长进程共用同一格式（`snapshot` 与 `click @ref` 允许分开两次调用）。

### ADR-04：run 模式用有界 ReAct，而不是 plan-then-execute

网页（jev-browser）可以在任务开始生成全量计划、漂移才重规划；桌面 App 状态易变（弹窗、广告、登录失效随时出现），全量计划很快过期。因此 run 模式每轮做「紧凑观察 → 规划 LLM 出 1–3 步 → 执行 → 代码断言 + Jev 校验」，循环到 `success_criteria` 满足或预算耗尽。规划器只见紧凑文本观察（vlm 档才见图），控 token。`execute` 模式仍保留完整步骤契约，供外部 Agent 显式编排。

### ADR-05：同步单进程，无门禁，动作账本仅观测

用户已选安全姿态 A：无审批、无白名单、无策略门。状态机只有 `running → done | failed | cancelled`。保留两样纯观测设施（不拦截任何动作）：JSONL 动作账本（前后快照摘要+参数，供排查回放）与 `--dry-run`（只观察解析目标不执行）。无任务持久化：MCP 请求即任务，进程退出即终止；长时间任务建议用 CLI。

### ADR-06：UIA 库主选 `uiautomation`，备选 `pywinauto`，P0 实测锁定

`uiautomation`（2.0.29）纯 Python + ctypes 直连 UIA，API 直接映射元素/Pattern，中文社区验证充分（微信/QQ 自动化案例），自带窗口管理 helper；`pywinauto` 最新版停留在 0.6.9（2026-09-24 核对），其自带 wrapper 抽象与我们的通用 ref 设计冲突。主选 uiautomation；因 P0 可能暴露其卡死或兼容问题，observe/act 各自收敛在接口层之后，允许整体替换。依赖注入方式：core 不直接 import 库，经由 `observe/uia_tree.py` 与 `act/uia_actions.py` 两个适配模块。

## 3. 技术基线

| 组件 | 选型 | 版本（2026-09-24 核对，P1 锁定精确版本） |
| --- | --- | --- |
| 语言 | Python | ≥ 3.10（推荐 3.11/3.12；`rapidocr` 支持 ≥3.8，`mcp` 要求 ≥3.10） |
| UIA | `uiautomation` | 2.0.29 |
| 截图 | `mss` + `Pillow` | 10.2.0 / ^10 |
| OCR | `rapidocr`（v3 统一包） | 3.9.2（注意：旧包 `rapidocr-onnxruntime` 1.4.4 限 Python <3.13，不采用） |
| Jev | `typesafe-sdk`（官方） | 0.7.1；协议 `POST https://api.typesafe.ai/v1/systemone` |
| 规划器 | `httpx` 调 OpenAI 兼容 `/chat/completions` | 0.28.1 |
| 校验 | `pydantic` | 2.13.5 |
| MCP | `mcp` 官方 Python SDK | 2.2.0 |

- Windows OCR（`Windows.Media.Ocr`，经 `winocr`/WinRT 包）列为后续优化：`winocr` 0.0.15 低版本且 WinRT 包对 Python 版本敏感，首版 OCR 只做 rapidocr，避免 P0 风险面扩大。
- 不使用 pyautogui / pywin32：输入用自研 ctypes SendInput（`KEYEVENTF_UNICODE` 直打中文），窗口管理用 uiautomation 自带 helper + 少量 ctypes。
- 进程启动即设置 DPI 感知（`PER_MONITOR_AWARE_V2`），否则截图/UIA 矩形/点击坐标在高分屏上系统性错位。需 P0 验证与 uiautomation 自身初始化的交互。

## 4. 观察通道设计

### 4.1 快照与渐进遍历

- `uia` 快照默认深度 3：每行输出 `role | name | AutomationId | value(截断) | 状态 | 矩形`，交互元素（可 invoke/value/toggle/select/expand 的）分配 ref；截断容器显示 `children_count` 并给可下钻 ref，`snapshot --root @ref` 局部展开（借鉴 agent-desktop 骨架模式，治理密集应用 token 膨胀）。
- `ocr` 档输出文字块列表：文本 + 包围盒中心物理像素坐标 + 置信度 + ref；按版面从上到下、从左到右排序。
- `vlm` 档把降采样截图发给配置的多模态模型，要求返回结构化元素清单（描述/类型/近似坐标/可执行动作推测）；坐标精度劣于 OCR，仅用于定位意图。
- 全部截图走 mss；区域截取优先（目标窗口矩形），整屏仅在显式要求时使用。

### 4.2 ref 注册表与会话

- 会话文件：`%LOCALAPPDATA%\AI-Redfish\jev-desktop\sessions\<id>.json`，默认 TTL 1 小时；MCP 进程内存与会话文件双写，跨进程可见。
- 解析 ref 时先查注册表，再按 ADR-03 校验活性；校验失败返回 `STALE_REF` + 最新快照建议。
- 同一时刻只允许一个桌面观察/动作在执行：引擎内建专用 UIA 工作线程 + 任务队列，串行化所有 COM/UIA 调用（规避 COM 跨线程初始化问题与自竞争），MCP 并发请求自然排队。

### 4.3 目标选择

- 目标窗口支持 `--app <名称|pid>` / `--title <子串>` / `--window-id`；多个匹配且未指定时，`run` 用 Jev `Choice` 消歧（低置信返回候选列表），`execute`/`snapshot` 直接返回候选列表由调用者选，不猜"第一个就是"。

## 5. 动作通道设计

| 类别 | 动作 | 实现 | 前置条件 |
| --- | --- | --- | --- |
| 语义动作（优先） | invoke/click、set_value、toggle/check/uncheck、select、expand/collapse、scroll（UIA Scroll） | UIA Pattern，不抢焦点，对用户干扰最小 | ref 或 selector 可解析 |
| 坐标动作（兜底） | click、double-click、right-click、hover、drag | ctypes SendInput 绝对坐标 | 目标窗口已置前台 |
| 键盘 | press（单键/组合键）、type 文本 | SendInput 扫描码；文本 ≤200 字符走 `KEYEVENTF_UNICODE`，长文本可选剪贴板+Ctrl+V 快速通道（用完尽力恢复原剪贴板） | 焦点在正确控件（type 前先 focus） |
| 窗口管理 | launch（exe/名称）、close、focus、minimize/maximize/restore、move/resize、list_windows | uiautomation helper + ctypes | — |
| 等待 | 元素出现/消失（UIA 轮询）、文字出现（OCR）、固定 sleep | 引擎步骤间同步，单次 wait 上限 `waitMaxMs` | — |

- 坐标动作前用 `SetActive`（内部处理 `SetForegroundWindow` 前台锁限制）把目标窗口置前台；这会短暂打断用户当前操作，文档如实声明"坐标动作期间请勿占用鼠标键盘"。
- 语义动作不置前台不抢焦点，是默认推荐路径；只有 ref 来自 `ocr`/`vlm` 档时才走坐标。

## 6. Jev 设计

| 场景 | 原语 | 说明 |
| --- | --- | --- |
| 语义元素定位 | Choice | 候选 = 快照中的交互元素/文字块（≤200 项，超限先按区域/类型分组再选）；必须含 `no_match` 项；返回 ref + 概率分布 |
| 视觉目标定位 | Choice | 在 OCR 文字块/VLM 元素列表中选目标 → 中心坐标 |
| 步后校验 | 多个 Noul 并行 | 同一状态上并行问：`目标状态是否已出现` / `是否有阻塞弹窗` / `是否出现错误`；独立问题合并一次请求 |
| 窗口消歧 | Choice | 多窗口匹配时选择目标窗口，置信度低 → 返回候选列表 |
| 语义断言 | Noul | `success_criteria` 中无法代码化的自然语言条件 |

- 概率只用于**路由**：高置信 → 执行；低置信 → 重新观察/分组/报 `AMBIGUOUS_TARGET`。概率不是授权（本工具无授权概念），只决定"下一步做什么"。
- 一次请求里只问相互独立的问题；依赖前一答案的问题拆到下一次请求（上游规范）。
- Choice 单题上限以上游文档为准（jev-browser 研究记录口径为 255 项），实现层自限 200 留余量；P0 复核。

### 6.1 Jev provider 预设

| 预设 | baseUrl | model | 说明 |
| --- | --- | --- | --- |
| `bocha`（默认） | `https://jev.bocha.cn` | `bocha-jev-v1` | 博查 Jev，与 jarvis 预设一致 |
| `typesafe` | `https://api.typesafe.ai` | `jev-latest` | TypeSafe 官方，走官方 SDK |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` | Vercel AI Gateway，协议同构（P0 核对） |
| `zen` | `https://opencode.ai/zen` | `jev-1.13` | OpenCode Zen，协议同构（P0 核对其 `/v1/systemone` 差异） |
| `custom` | 用户填 | 用户填 | 任意 TypeSafe 协议兼容端点 |

- 实现优先用官方 `typesafe-sdk`；`bocha`/`vercel`/`zen`/`custom` 端点协议同构（`POST /v1/systemone`），SDK 支持自定义 baseUrl 则复用，否则退化为薄 httpx 适配（P1 按 SDK 实际能力定）。
- key 一律经环境变量引用（`apiKeyEnv`，默认 `TYPESAFE_API_KEY`），配置文件不落真实 key。

## 7. 规划器（run 模式）

```text
goal + success_criteria
        │
   ┌────▼─────────────────────────────────────────┐
   │ 循环（预算内）：                               │
   │   观察（按 observation.level）→ 紧凑状态       │
   │   规划 LLM：出 1–3 步（严格 JSON）             │
   │   逐步执行：语义目标 → Jev 选择 → 动作          │
   │   校验：代码断言 + Noul(done/blocked/error)    │
   │   done → 结束；blocked/error → 按策略处理      │
   └──────────────────────────────────────────────┘
```

- 输入：`goal`（自然语言）、可选 `app` 窗口定位、可选 `success_criteria`（代码可判定条件或自然语言条件列表）、预算覆盖（只可缩短全局默认）。
- 输出：统一 envelope（§9），含逐步结果、证据、用量。
- 规划器输出经 pydantic 严格校验（FlowStep[]，复用 §8 契约的子集）；校验失败最多一次修复请求（把校验错误回传），仍失败即 `PROVIDER_ERROR`。
- 规划器不放宽预算；`success_criteria` 缺失时 CLI 交互补问，`--json`/MCP 非交互场景按"完成 goal 的直接可观察结果"处理并在结果中标注未配置验收。
- `planner` 未配置时调用 `run` 返回 `PLANNER_NOT_CONFIGURED`，不猜模型/供应商；`execute` 不依赖规划器配置。
- `observation.vlm` 未单独配置时回落使用 `planner` 的端点（单 key 即可用的便利路径），配置文件里注明数据将发往该端点。

## 8. execute 契约（拟议 v1）

TargetSpec（步骤/动作的定位方式，带 kind 的联合）：

```jsonc
{ "kind": "ref", "ref": "@s8f3k2p9:e12" }                    // 快照 ref
{ "kind": "uia", "controlType": "Button", "name": "保存",    // UIA 选择器
  "automationId": "btn-save", "index": 0, "scope": "window" }
{ "kind": "coords", "x": 500, "y": 300 }                     // 物理像素
{ "kind": "text", "target": "搜索框" }                        // 语义目标 → Jev 选择
{ "kind": "none" }                                            // 全局动作（press/launch/wait 等）
```

FlowStep（kind 联合）：

- `action`：`act ∈ {click, double_click, right_click, type, set_value, press, scroll, select, toggle, expand, collapse, focus, launch, close, clipboard_get, clipboard_set}` + `target: TargetSpec` + `value?` + 可选 `expect`（后置条件：元素出现/消失/文字出现/窗口标题变化）。
- `goal`：`goal` + 可选候选约束；走 Jev 局部循环（观察→选择→动作→校验），是 execute 内唯一的语义步骤形态。
- `wait`：元素/文字/时间，`timeoutMs` 上限 `waitMaxMs`。
- `screenshot`：截取并保存 artifact，返回路径。
- `extract`：从快照提取字段（文本/值/矩形），`saveAs` 变量，供后续步骤引用（`${var}` 仅限变量白名单，不做任意插值）。
- `assert`：对变量/窗口/元素的确定性断言（equals/contains/exists 等白名单算子），禁任意代码。

示例（记事本写字并保存；未保存时 `ctrl+s` 会弹保存对话框，其控件结构因系统/版本而异，所以用 `goal` 语义步骤处理，不硬编码对话框控件）：

```json
{
  "schemaVersion": 1,
  "app": "记事本",
  "steps": [
    { "id": "s1", "kind": "action", "act": "type", "target": { "kind": "text", "target": "文本编辑区" }, "value": "hello 桌面" },
    { "id": "s2", "kind": "action", "act": "press", "target": { "kind": "none" }, "value": "ctrl+s" },
    { "id": "s3", "kind": "goal", "goal": "在弹出的保存对话框中把文件名设为 hello.txt 并保存到桌面" }
  ]
}
```

`s3` 展示 execute 内的语义步骤：它走 Jev 局部循环（观察→选择→动作→校验），是 execute 中唯一允许调用模型的步骤形态。

## 9. 状态机、输出与错误码

```text
running → done | failed
running → cancelled（Ctrl+C / MCP 客户端断开，尽力而为的协作取消）
```

统一 envelope：

```jsonc
{
  "schemaVersion": 1,
  "status": "done",              // done | failed | cancelled
  "steps": [ /* 逐步结果：id/act/目标摘要/结果/证据 ref */ ],
  "evidence": { "snapshots": ["s8f3k2p9"], "artifacts": ["C:\\...\\artifacts\\t1\\shot.png"] },
  "metrics": { "steps": 3, "actions": 3, "jevRequests": 2, "plannerRequests": 0,
               "tokens": { "input": 4310, "output": 210 }, "elapsedMs": 8213 },
  "error": null                  // { code, message, retryable, details }
}
```

错误码：`STALE_REF` / `TARGET_NOT_FOUND` / `AMBIGUOUS_TARGET` / `APP_NOT_FOUND` / `WINDOW_LOST` / `UIA_UNAVAILABLE` / `OCR_UNAVAILABLE` / `PLANNER_NOT_CONFIGURED` / `PROVIDER_ERROR` / `INVALID_STEP` / `BUDGET_EXCEEDED` / `TIMEOUT` / `INPUT_DENIED`（UIPI）/ `INTERNAL_ERROR`。`retryable` 只表示请求层可否重试；外部动作已派发后超时不代表未生效，先核实后置状态再决定，不盲目重放。

预算默认值（配置可调，任务只可缩短）：`runTimeoutMs=120000`、`actTimeoutMs=30000`、`snapshotTimeoutMs=15000`、`waitMaxMs=30000`、`maxSteps=40`、`maxPlannerRequests=12`、`maxJevRequests=80`、`maxInputTokens=200000`、`maxOutputTokens=20000`。usage 缺失时记录 unknown，不当作零。

## 10. 对外入口

### 10.1 MCP 工具（stdio，经 launcher.json 拉起）

| 工具名 | 作用 |
| --- | --- |
| `desktop_doctor` | 环境诊断（默认不访问网络；`--with-network` 才 ping Jev/规划器，输出脱敏，绝不打印 key） |
| `desktop_windows` | 列顶层窗口（标题/pid/矩形/前台标记） |
| `desktop_snapshot` | 观察目标窗口（level=uia/ocr/vlm/auto）→ 紧凑文本 + refs + snapshotId |
| `desktop_act` | 单动作（TargetSpec 定位），同步返回 |
| `desktop_execute` | 步骤数组批量执行（无内部规划） |
| `desktop_run` | 完整目标 → 规划 LLM + Jev 循环 |
| `desktop_screenshot` | 返回 MCP image 内容（供多模态宿主直接看图） |
| `desktop_clipboard` | 读/写/清剪贴板 |

### 10.2 CLI（argparse 从 TOOLS 元数据自动生成，同 server-py 模式）

- 子命令与 MCP 工具一一对应：`doctor / windows / snapshot / act / execute / run / screenshot / clipboard`；全局参数 `--config`、`--json`（禁交互，纯 envelope 输出）、`--dry-run`、`--session <id>`、`--timeout`。
- 退出码：0 done；2 参数/配置错误；4 failed；130 cancelled（SIGINT）。
- 长任务建议用 CLI（无客户端超时压力）；MCP 场景建议把 `runTimeoutMs` 调低或拆步骤为 `execute`。

### 10.3 stdout/stderr 纪律

- MCP stdio 下 **stdout 是协议通道**：所有日志/进度写 stderr；CLI 结果写 stdout、进度写 stderr。
- Windows 控制台强制 UTF-8（`sys.stdout.reconfigure(encoding="utf-8")`），JSON 输出 `ensure_ascii=False`；中文 App 名与结果不乱码（server-py 已验证此做法）。

## 11. 配置设计

优先级：CLI 显式参数 > 环境变量（`JEV_DESKTOP_*`）> `%LOCALAPPDATA%\AI-Redfish\jev-desktop\config.json` > 默认值。启动器会把子进程 cwd 切到工具目录，配置发现不依赖 cwd；配置文件内相对路径按文件所在目录解析。

| 字段 | 环境变量 | 默认 / 说明 |
| --- | --- | --- |
| `observation.level` | `JEV_DESKTOP_OBS_LEVEL` | `auto`；另有 `uia / ocr / vlm` |
| `observation.uia.maxDepth` | — | `3`；骨架快照深度 |
| `observation.uia.maxElements` | — | `800`；超过则截断并给出下钻 ref |
| `observation.ocr.backend` | — | `rapidocr`（windows 为预留值，首版未实现） |
| `observation.vlm.baseUrl/model/apiKeyEnv` | `JEV_DESKTOP_VLM_*` | 未配置时回落 `planner` 端点 |
| `planner.baseUrl/model/apiKeyEnv` | `JEV_DESKTOP_PLANNER_*` | 无默认；配置后 run 才可用 |
| `planner.temperature / maxTokens` | — | `0.2` / `2048` |
| `jev.provider` | `JEV_DESKTOP_JEV_PROVIDER` | `bocha`；另有 `typesafe / vercel / zen / custom` |
| `jev.baseUrl / model` | `JEV_DESKTOP_JEV_*` | 随预设；`custom` 必填 |
| `jev.apiKeyEnv` | — | `TYPESAFE_API_KEY` |
| `runtime.*TimeoutMs / maxSteps / maxPlannerRequests / maxJevRequests / maxInputTokens / maxOutputTokens` | `JEV_DESKTOP_*` | 见 §9 默认值 |
| `session.dir / session.ttlMs` | — | `%LOCALAPPDATA%\...\sessions` / `3600000` |
| `runtime.dataDir / artifactsDir / logDir` | `JEV_DESKTOP_DATA_DIR` 等 | `%LOCALAPPDATA%\AI-Redfish\jev-desktop\...` |
| `log.actions` | — | `true`；动作账本 JSONL（仅观测） |

未知字段报错；布尔值只接受 `true/false/1/0`；`doctor` 输出脱敏有效值与来源，绝不打印 secret。

## 12. 安全姿态（A：无门禁）与数据边界

- 所有动作直接执行，无确认/白名单/策略门；这不是遗忘而是已确认的决策（个人自用场景），后续如需 B（轻量风险分级）在引擎动作派发点留有唯一插槽。
- 动作账本（JSONL）与 `--dry-run` 仅用于观测与调试，不拦截。
- 数据边界如实声明：快照文本/OCR 文字/截图（vlm 档或 `desktop_screenshot`）会发送到所配置的 Jev/规划器/VLM 端点；整屏截图可能含敏感信息，默认只截目标窗口区域。

## 13. 效率策略

1. 复用 HTTP 客户端（Jev/规划器）与 mss 实例；不每步重建。
2. `uia` 快照增量：窗口未变时只下发变化子树；首版先做全量快照 + 数量/深度预算截断，增量为 P2 后期可选优化。
3. 独立问题合并一次 Jev 请求（并行 Noul）；候选压缩只减冗余不漏关键上下文。
4. 等待用事件/轮询+上限，不固定 sleep，不等待全应用"空闲"。
5. 同状态判断结果不跨导航缓存；ref 每次动作前校验。
6. 预算贯穿连接、等待、重试；SDK 重试 × 外层重试相乘要避免（重试统一收口在适配层）。

## 14. 平台限制（如实声明）

| 限制 | 说明 |
| --- | --- |
| 管理员窗口（UIPI） | 非管理员进程无法对提权窗口合成输入/部分 UIA 操作；doctor 检测并提示以管理员重开终端；首版不做 UAC 自动化 |
| 锁屏 / RDP 断开 | 锁屏后 GDI 截图失效（黑帧/旧帧），输入合成无效；RDP 会话断开后桌面可能最小化；ocr/vlm 档与坐标动作要求桌面可见 |
| 游戏/自绘 | DirectInput/Raw Input 游戏可能忽略合成输入；UIA 树为空 → auto 落 ocr 档 |
| IME | `KEYEVENTF_UNICODE` 与 `ValuePattern.SetValue` 均绕过输入法（行为可预期）；依赖 IME 联想的场景不适用 |
| 坐标动作独占 | 坐标动作期间用户不得占用鼠标键盘；语义动作无此限制 |
| 单任务串行 | 同一时刻一个桌面观察/动作；并行桌面任务不在首版范围 |

## 15. 可观测性

- 统一 task/step 关联 ID；记录排队/观察/Jev/规划/动作/校验分段耗时、模型实际版本、token usage（缺失记 unknown）。
- 动作账本 JSONL：时间、动作、定位摘要、前后快照指纹、结果；不含值全文（type 的文本截断存储），不含 key。
- 能力探测（doctor）：`uia 可用性 / ocr 后端 / 截图 / 剪贴板 / DPI / 提权状态 / provider 连通（--with-network）`；未知能力不标 supported。
