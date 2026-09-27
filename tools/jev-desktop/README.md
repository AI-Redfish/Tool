# jev-desktop —— Windows 桌面软件控制工具

> 状态：**已实现**（P1–P5 核心功能交付）。基于「规划 LLM + Jev 判断」控制 Windows 桌面上的**任意软件**：
> UIA 辅助功能树读结构、Jev 做局部语义判断、规划 LLM 做任务拆解、UIA Pattern 与 SendInput 做动作。
> MCP（stdio）与 CLI 两种提供方式共享同一份 `core`，所有失败返回可操作错误码与证据，不假装成功。

## 已实现能力

| 模块 | 说明 |
| --- | --- |
| 观察通道 | `uia`（UIA 语义树紧凑快照 + ref，默认）/ `ocr`（mss 截图 + rapidocr 文字块）/ `vlm`（降采样截图 → 多模态模型）；`auto` 按 UIA 探测降级，OCR 为空时提示显式升档（不静默，费用可见） |
| 渐进骨架 | 快照默认深度 3 + 截断容器 `children_count` + `--root <ref>` 局部下钻，治理密集应用 token 膨胀 |
| ref 体系 | `@<快照id>:eN`（UIA 元素）/ `:bN`（文字块）；动作前活性校验（pid + 指纹 + RuntimeId/矩形漂移），失效返回 `STALE_REF`，**绝不盲点旧坐标** |
| 动作通道 | UIA 语义动作（invoke/set_value/toggle/check/uncheck/select/expand/collapse/scroll/focus，不抢焦点）；SendInput 坐标动作（click/double_click/right_click/hover/drag，先置前台）；键盘（组合键 + `KEYEVENTF_UNICODE` 直打中文，长文本剪贴板快速通道并恢复原剪贴板）；窗口管理（launch/close/focus/minimize/maximize/restore/move/resize） |
| execute | 外部步骤数组（action/wait/screenshot/extract/assert/goal），确定性动作零模型调用；`expect` 后置条件；`${var}` 白名单插值；`goal` 是唯一语义步骤（Jev 局部循环） |
| run | 一句话目标 → 规划 LLM 有界 ReAct（观察 → 规划 1-3 步 → 执行 → Jev done/blocked 校验 → 循环）；`PLANNER_NOT_CONFIGURED` 明确报错；规划器反复误报完成有熔断 |
| 预算 | runTimeoutMs / actTimeoutMs / snapshotTimeoutMs / waitMaxMs / maxSteps / maxPlannerRequests / maxJevRequests / maxInput/OutputTokens；任务只可缩短全局默认 |
| 可观测 | JSONL 动作账本（仅观测，不含值全文与 key）；artifact 落盘（截图/步骤截图）；统一 envelope（status/steps/evidence/metrics/error） |
| doctor | 平台/DPI/UIA/截图/OCR/剪贴板/提权/会话目录/凭据检查；`with_network=true` 才连通 Jev 与规划器；输出脱敏 |

## 快速开始

```powershell
# 安装依赖（MCP 经启动器首次 build 时自动执行）
pip install -r tools/jev-desktop/requirements.txt
# OCR 档（可选）
pip install -r tools/jev-desktop/requirements-ocr.txt
```

CLI（在 `tools/jev-desktop/` 下）：

```powershell
python cli.py doctor                  # 环境诊断
python cli.py windows                 # 列出可见顶层窗口
python cli.py snapshot --app 记事本    # 观察窗口 → 紧凑文本 + refs
python cli.py act click --target "@<快照id>:e5" --session default
python cli.py execute --file examples/console.flow.json --title "窗口标题"
python cli.py run "在记事本里写 hello 并保存" --app 记事本   # 需已配置 planner
```

退出码：0 done；2 参数/配置错误；4 failed；130 cancelled。

MCP（`.mcp.json`）：

```json
{ "mcpServers": { "jev-desktop": { "command": "npx", "args": ["-y", "github:AI-Redfish/Tool", "jev-desktop"] } } }
```

MCP 工具：`desktop_doctor / desktop_windows / desktop_snapshot / desktop_act / desktop_execute / desktop_run / desktop_screenshot / desktop_clipboard`（与 CLI 子命令一一对应）。`desktop_screenshot` 返回 MCP image 内容供多模态宿主直接看图。

## 两种模式如何选择

- 已知流程、能写明确步骤 → `execute`：确定性动作零模型调用；步骤内允许 `goal` 型语义步骤。
- 只有一句话目标 → `run`：需要已配置规划 LLM；内部有界 ReAct，预算硬上限。
- 两者共用同一执行引擎与输出契约；不新增模型请求来猜该用哪个入口，调用者显式选择。

## 配置

优先级：CLI 参数 > 环境变量（`JEV_DESKTOP_*`）> `%LOCALAPPDATA%\AI-Redfish\jev-desktop\config.json` > 默认值；未知字段报错；布尔只接受 `true/false/1/0`。

```jsonc
{
  "schemaVersion": 1,
  "observation": { "level": "auto" },
  "jev": { "provider": "bocha", "apiKeyEnv": "TYPESAFE_API_KEY" },
  "planner": {
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKeyEnv": "JEV_DESKTOP_PLANNER_API_KEY"
  },
  "runtime": { "runTimeoutMs": 120000, "maxSteps": 40 }
}
```

Jev provider 预设：`bocha`（默认，`https://jev.bocha.cn` + `bocha-jev-v1`）/ `typesafe` / `vercel` / `zen` / `custom`（协议同构，`POST {baseUrl}/v1/systemone`）。key 一律经环境变量（`apiKeyEnv`），配置文件不落真实 key。字段明细见 [DESIGN.md §11](DESIGN.md)。

## 架构一览

```text
        MCP 客户端（Agent）          CLI（人/脚本）
                 │                      │
           mcp_server.py             cli.py        ← 薄适配器
                 └─────────┬──────────┘
                    core（TOOLS 元数据 + run_tool 分发）
                           │
        ┌──────────────────┼──────────────────┐
   execute 模式        run 模式            doctor
 （外部步骤，无规划） （goal → 规划 LLM 有界 ReAct）
           └───────┬───────┘
           执行引擎（预算 / 状态机 / 动作账本）
                │                 │
        观察通道 Observe       动作通道 Act
   uia_tree │ ocr │ vlm     UIA Pattern │ SendInput │ 窗口管理
                │
     Jev 判断：元素选择 Choice / 校验 Noul（并行）
```

- `core/`：纯逻辑包（`errors/config/tooldata/envelope/winapi/worker/session/ledger` + `observe/act` + `judge/planner/steps/targeting/executor/goal_loop/runner/doctor/api`）；
- `cli.py` / `mcp_server.py`：薄适配器，子命令与 inputSchema 从 `core.TOOLS` 自动生成；
- 专用 UIA 工作线程：所有 COM/UIA/mss 调用串行化在单一 STA 线程（带消息泵），超时“毒化”重建，目标窗口挂起不拖死工具进程；
- 纯 ctypes 原生层（`winapi.py`）：SendInput/窗口/剪贴板/DPI 不依赖第三方包。

## 安全姿态与数据边界（A：无门禁，已确认的决策）

- 所有动作直接执行，无确认/白名单/策略门；`--dry-run` 与动作账本仅用于观测，不拦截。
- 快照文本/OCR 文字/截图（vlm 档或 `desktop_screenshot`）会发送到所配置的 Jev/规划器/VLM 端点；整屏截图可能含敏感信息，默认只截目标窗口区域。
- 坐标动作期间会把目标窗口置前台，请勿占用鼠标键盘；UIA 语义动作不抢焦点。
- 管理员窗口（UIPI）无法合成输入；锁屏/RDP 断开后截图与输入失效。完整限制清单见 [DESIGN.md §14](DESIGN.md)。

## 实现说明（与设计草案的差异）

- **MCP 传输层**：官方 `mcp` SDK 未采用（1.x→2.x 已发生 FastMCP→MCPServer 破坏性改名），改为标准库手写 JSON-RPC stdio 循环（server-py 同款做法），只依赖 tools 协议子集，零版本风险。
- **typesafe-sdk**：未引入；bocha/vercel/zen/custom 均为协议同构端点，统一走 `core/judge.py` 薄 httpx 适配（含重试收口与 usage 统计），一套代码覆盖全部预设。
- **pydantic**：规划器/步骤校验改为手写严格校验器（`core/steps.py`），错误信息更精确，减少一个编译依赖。
- **execute act 白名单**：在 DESIGN §8 契约子集上放开了 hover/drag/invoke/check/uncheck/minimize/maximize/restore/move/resize（与 `desktop_act` 对齐，README 注明）。
- **错误码扩展**：在 DESIGN §9 之外补充 `CONFIG_INVALID` / `INVALID_PARAMS` / `ASSERT_FAILED` / `GOAL_BLOCKED`（引擎状态需要）。
- **Windows Terminal 场景**：快照读取 TextPattern 可见区域作为终端文本来源（终端内容不经子元素暴露）。
- 未经真实模型 P0 实测的项（Choice 候选上限、规划 JSON 通过率、六应用矩阵）仍按 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) 后续推进。

## 本地测试

```powershell
python tests/test_core.py          # 离线单元测试（config/steps/session/judge/vlm）
python tests/mock_server.py 8778   # 本地 mock：OpenAI 兼容规划 + TypeSafe SystemOne + VLM 视觉
powershell -ExecutionPolicy Bypass -File tests/fixture_winforms.ps1
                                   # WinForms 测试窗体（按钮/复选框/文本框/下拉框，供语义动作实测）
```

mock 特殊标记：goal 含 `BLOCKED-TEST` → 验证 GOAL_BLOCKED；`BADJSON-TEST` → 验证规划校验失败；`NOTDONE-TEST` → 验证预算耗尽熔断；`RETRY-TEST` → 验证 429 重试收口；chat 含 image_url → 返回 VLM elements JSON。

另开终端（指向 mock，不需要真实 key）：

```powershell
set JEV_DESKTOP_PLANNER_BASE_URL=http://127.0.0.1:8778/v1
set JEV_DESKTOP_PLANNER_MODEL=mock-model
set JEV_DESKTOP_PLANNER_API_KEY=mock-key
set JEV_DESKTOP_JEV_PROVIDER=custom
set JEV_DESKTOP_JEV_BASE_URL=http://127.0.0.1:8778/v1
set JEV_DESKTOP_JEV_MODEL=mock-jev
set JEV_DESKTOP_JEV_API_KEY_ENV=JEV_DESKTOP_PLANNER_API_KEY
python cli.py run "在控制台输出 RUN-OK-MOCK" --title "目标窗口" --session smoke
python cli.py act click --target "{\"kind\":\"text\",\"target\":\"点击确定按钮\"}" --title "jev-fixture-窗口"
```

## 文档导航

1. [DESIGN.md](DESIGN.md)：架构决策（ADR）、三档观察通道、动作通道、Jev/规划器设计、契约、配置、限制。
2. [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)：P0 选型验证门 → P1..P6 分阶段交付、退出门槛。
3. [RESEARCH.md](RESEARCH.md)：参考项目差异、公开来源索引、已核实事实、假设与待验证项。
