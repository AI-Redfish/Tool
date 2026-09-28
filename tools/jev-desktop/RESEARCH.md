# jev-desktop 研究依据、假设与风险

> 方案版本：v0.1；核对日期：2026-09-24。仅完成公开资料核对与在线文档/PyPI 元数据抓取，未连接用户桌面执行 UIA/OCR 实测，未调用任何付费模型。
> 配套文档：[设计](DESIGN.md)、[开发计划](DEVELOPMENT_PLAN.md)。

## 1. 本地规范依据

已读取并据此设计：

- 仓库根 `README.md`、`tools/README.md`：启动器 + 工具集合；core 与适配器分离；`TOOLS` 元数据单一事实来源；`launcher.json` 多语言接入；stdout/stderr 纪律；Windows 上 Python 强制 UTF-8 的既有做法（server-py）。
- `tools/server-py/core.py|cli.py|mcp_server.py|launcher.json`：Python 工具的分层同构样板（本工具沿用分层，但依赖真实第三方包，不再是纯标准库）。
- `tools/jev-browser/README.md|DESIGN.md|DEVELOPMENT_PLAN.md|RESEARCH.md`：本仓库已确立的工具级设计范式——execute/run 双模式、确定性动作优先/语义判断走 Jev、预算控制、doctor、能力如实声明、P0 阻塞门、文档四件套。本工具直接继承该范式并按桌面场景调整。
- 当前工作空间 `AGENTS.md`：先澄清真实需求、再审查输出；本方案已通过三轮用户确认（目标应用 C / 模型可换 C / 安全姿态 A）。

本次仅新增本工具的规划文档，并在根 `README.md` 与 `tools/README.md` 的"规划中的工具"处插入入口；不把它加入"可用工具"表，不创建运行入口。

## 2. 参考项目快照与差异

### 2.1 jev-chat/jev-chat-jarvis

```text
https://github.com/jev-chat/jev-chat-jarvis
访问日期：2026-09-24；main 分支；语言 Kotlin；stars 5,527（API 实时值）
```

定位：Android 端聊天应用自动回复助手。观察走 Android 无障碍服务 + 端侧 ML Kit OCR；模型分工为「Jev 判断（意图/危险等级/是否合并回复）+ 回复 LLM（默认 deepseek-chat-v3.1，OpenRouter 可换）」；判断/回复/视觉三个接口独立配置。

| 借鉴点 | 本工具的调整 |
| --- | --- |
| Jev 判断 + LLM 生成的双模型分工 | 保留；生成分工改为「任务步骤规划」（jarvis 是聊天回复），判断分工一致 |
| provider 多预设（协议同构，可自定义端点） | 保留并落到 Jev 预设表（bocha/typesafe/zen/custom）与规划器 OpenAI 兼容配置 |
| 无障碍树 + 端侧 OCR 双通道观察 | 保留；Windows 对应物为 UIA + rapidocr |
| 「只自动回复、不自动发送」的保守边界 | 形态不同：用户已拍板首版无门禁（安全姿态 A），但"边界必须显式声明"的思想保留在 DESIGN §12/§14 |
| 危险等级等 Score 判断 | 首版不采用（无门禁场景无消费方）；留作后续安全姿态 B 的挂点 |

### 2.2 lahfir/agent-desktop

```text
https://github.com/lahfir/agent-desktop
访问日期：2026-09-24；main 分支；语言 Rust；stars 1,621；Apache-2.0
```

定位：桌面 computer-use 执行层（Rust CLI + C-ABI FFI），通过 OS 辅助功能树观察与操作应用，"快照 + 稳定 ref（`@s8f3k2p9:e1`）+ 渐进骨架遍历（78–96% token 削减）+ headless 语义动作 + session/trace + CDP 互操作"。

**关键事实：其 Platform Support 表中，辅助功能树/点击输入/鼠标/截图/剪贴板/窗口管理等全部能力在 Windows 列均为 Planned，仅 macOS 为 Yes。** 因此只借鉴范式，不作为运行时依赖：

| 借鉴点 | 本工具的调整 |
| --- | --- |
| 快照 + 限定 ref + 动作前活性校验 | 保留，自研（DESIGN ADR-03）；ref 指纹含 UIA 特有字段 |
| 渐进骨架遍历治 token 膨胀 | 保留：默认深度 3 + children_count + `--root` 下钻 |
| headless 语义动作默认、坐标动作例外 | 保留：UIA Pattern 不抢焦点优先，ocr/vlm ref 才走坐标 |
| 结构化 JSON 输出 + 错误码 + 恢复提示 | 保留：统一 envelope + 错误码表 |
| session/trace、批量 batch | trace 简化为动作账本 JSONL；batch 合并入 execute |
| CDP 互操作 | 首版不做；浏览器场景由 jev-browser 承担，本工具只管桌面外壳 |

### 2.3 与 jev-browser（本仓库）的关系

同一套工程范式（分层/元数据/预算/doctor/文档四件套），不同执行域：jev-browser 管 Playwright 可控的浏览器内容，jev-desktop 管浏览器之外的整个桌面。两者不共享运行时；未来若 jev-browser 需要操作浏览器原生外壳（窗口/标签之外的对话框），可复用本工具的窗口管理。

## 3. 已核实事实（2026-09-24 在线核对）

| 事实 | 来源 |
| --- | --- |
| TypeSafe 官方 Python SDK：`pip install typesafe-sdk`（PyPI 0.7.1，requires Python ≥3.10，import `typesafe_sdk`，`TypeSafeClient.system_one(state, questions)`，环境变量 `TYPESAFE_API_KEY`） | [S4] |
| TypeSafe HTTP API：`POST https://api.typesafe.ai/v1/systemone`，Bearer 认证，body `{state, model:"jev-latest", questions:{id:{type:noul|choice|score, instructions, criteria}}}`；instructions 支持 string/object；问题 key 不发给模型 | [S5] |
| jarvis 预设端点与协议：博查 Jev `https://jev.bocha.cn` + `bocha-jev-v1`；Vercel AI Gateway `https://ai-gateway.vercel.sh/typesafe` + `typesafe-ai/jev`；OpenCode Zen `https://opencode.ai/zen` + `jev-1.13`（有 `jev-1.13-free`）；均自称与 TypeSafe 直连协议同构（`POST /v1/systemone`） | [S2] |
| PyPI 现值：`uiautomation` 2.0.29；`rapidocr` 3.9.2（≥3.8,<4）；`rapidocr-onnxruntime` 1.4.4（**<3.13**，不采用）；`mss` 10.2.0（≥3.9）；`mcp` 2.2.0（≥3.10）；`httpx` 0.28.1；`pydantic` 2.13.5（≥3.9）；`typesafe-sdk` 0.7.1（≥3.10）；`pywinauto` 0.6.9（备选）；`winocr` 0.0.15（低版本，暂不采用） | [S6] |
| agent-desktop Windows 支持为 Planned（见 §2.2） | [S1] |
| TypeSafe 文档模型页存在 `jev-latest` 别名口径；Choice 候选上限的 255 口径沿自 jev-browser 研究记录，本工具自限 200 并留 P0 复核项 | [S3][S5] |

## 4. 公开来源索引

- [S1] agent-desktop 仓库与 README（架构、命令面、平台支持表、FFI）：`https://github.com/lahfir/agent-desktop`
- [S2] jev-chat-jarvis 仓库与 README（模型分工、provider 预设、OCR、安全边界）：`https://github.com/jev-chat/jev-chat-jarvis`
- [S3] TypeSafe 文档索引：`https://docs.typesafe.ai/llms.txt`
- [S4] TypeSafe Python SDK：`https://docs.typesafe.ai/sdk/python.md`（源码 `https://github.com/typesafe-ai/typesafe-sdk-python`）
- [S5] TypeSafe HTTP API 参考：`https://docs.typesafe.ai/api.md`
- [S6] PyPI JSON API（各包版本/requires_python，逐包核对）：`https://pypi.org/pypi/<pkg>/json`
- [S7] Microsoft UI Automation 概览（待 P1 实现时精读 Win32/UIAutomation COM 接口细节）：`https://learn.microsoft.com/windows/win32/winauto/entry-uiauto-win32`
- [S8] SendInput / KEYEVENTF_UNICODE（合成输入与 UNICODE 通道）：`https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-keybdinput`
- [S9] DPI Awareness（Per-Monitor V2 与坐标虚拟化）：`https://learn.microsoft.com/windows/win32/hidpi/setting-the-default-dpi-awareness-for-a-process`
- [S10] UIPI（完整性级别与提权窗口隔离）：`https://learn.microsoft.com/windows/win32/secauthz/user-account-control-and-user-interface-privilege-isolation`（标题口径，P1 核对精确路径）
- [S11] uiautomation 项目：`https://github.com/yinkaisheng/Python-UIAutomation-for-Windows`
- [S12] rapidocr：`https://github.com/RapidAI/RapidOCR`
- [S13] MCP Python SDK：`https://github.com/modelcontextprotocol/python-sdk`
- [S14] mss：`https://github.com/BoboTiG/python-mss`

标注口径：[S1][S2] 为仓库 README 实抓（含 GitHub API 元数据）；[S3]–[S6] 为文档/JSON 实抓原文；[S7]–[S10] 与 [S14] 为知名官方文档入口，本设计只引用其公认结论（坐标虚拟化、UNICODE 输入、UIPI、多屏抓取），未逐句核对全文，精确条款在 P1 实现对应模块时复核并回填。

## 5. 假设与待验证项

### 5.1 假设（未验证，不阻塞设计但阻塞实现）

1. 用户提供/将申请 Jev key（TYPESAFE_API_KEY 或博查等价物）与规划 LLM 的 OpenAI 兼容端点；具体厂商未知，故全配置化。
2. 用户在 Windows 原生侧装有 uv（`uv` 命令可达，https://docs.astral.sh/uv/）；依赖经 `uv sync` 装入工具目录下隔离的 `.venv`（`pyproject.toml` 声明，OCR 为 `--extra ocr`），launcher.json `command` 为 `uv run mcp_server.py` 自动复用该环境——已替代早期“pip 直装无 venv”假设（2026-09 项目化落地）。
3. jarvis 预设端点的协议同构性以其 README 自述为准；`zen`/`bocha` 的真实请求/响应差异 P0 实测。
4. 本工具用于用户本人设备与账号的自动化，合规责任在使用者；文档如实声明数据外发边界，不承诺对企业管控环境兼容。

### 5.2 待验证项（已排入 P0，见 DEVELOPMENT_PLAN §3）

- uiautomation 与 pywinauto 的六应用对比矩阵与卡死防护（**选型未锁定前不进入 P1**）。
- DPI 三方坐标一致性；COM 线程模型与 FastMCP 线程池的兼容路径。
- rapidocr v3 的准确率/耗时/内存；Electron 应用 a11y 激活行为；微信 4.x/钉钉的 UIA 暴露程度（决定其走 uia 还是 ocr 档）。
- typesafe-sdk 自定义 baseUrl 对同构端点的兼容性（决定 bocha/zen 走 SDK 还是薄 httpx 适配）。
- Choice 候选上限 255 口径复核；`jev-1.13`/`bocha-jev-v1` 对并行多问题的支持与行为差异。
- 锁屏/RDP 断开下各通道的实际表现（预期：截图黑帧、输入无效），固化诊断文案。

### 5.3 已知设计风险

1. **UIA 跨进程卡死**是本工具最大的稳定性风险；P0 若超时保护不足，备选路径是 pywinauto（自带等待逻辑）或对可疑 hwnd 预检 `IsHungAppWindow`，严重时把 uia 档标为"尽力而为"并在 doctor 中如实报告。
2. **无门禁姿态 A** 意味着错误的 run 目标可能造成真实副作用（删除文件、发送消息）；账本仅事后可查不能阻止。文档需在显著位置声明；后续若升级姿态 B，引擎动作派发点是唯一插槽。
3. **VLM 档坐标精度**天然低于 OCR/UIA；首版只承诺"定位意图 + 近似坐标"，不承诺像素级点击精度，必要时引导两次交互收敛。
4. MCP 长任务受宿主客户端超时约束；已在契约中给出"长任务走 CLI / 调低 runTimeoutMs"的路径，若仍不够再评估 MCP 长任务扩展或 HTTP API（jev-browser 的 api 层先例）。
