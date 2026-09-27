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
# 安装依赖（MCP 经启动器首次拉起时也会自动执行）
pip install -r tools/jev-desktop/requirements.txt
# OCR 档（可选）
pip install -r tools/jev-desktop/requirements-ocr.txt

# 最小上手链（在 tools/jev-desktop/ 下）
python cli.py doctor
python cli.py windows
python cli.py snapshot --app 记事本
```

完整接入方式（CLI 全命令 / MCP 注册 / 启动器）见下文[接入方式与使用步骤](#接入方式与使用步骤)；
退出码：0 done；2 参数/配置错误；4 failed；130 cancelled。

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

## 底层实现原理

与 jev-browser 同一套设计哲学：**一个核心（`core/`）+ 两个薄适配器（`cli.py` / `mcp_server.py`）**，所有入口共享同一执行引擎；区别在于观察/动作通道从浏览器换成了 Windows 桌面（UIA + SendInput）。

```text
        MCP 客户端（Agent）          CLI（人/脚本）
                 │                      │
           mcp_server.py             cli.py        ← 薄适配器（子命令/schema 从 TOOLS 自动生成）
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

- 模块划分：`core/` 纯逻辑包（`errors/config/tooldata/envelope/winapi/worker/session/ledger` + `observe/act` + `judge/planner/steps/targeting/executor/goal_loop/runner/doctor/api`）；`winapi.py` 为纯 ctypes 原生层（SendInput/窗口/剪贴板/DPI，不依赖第三方包）。
1. **专用 UIA 工作线程**：所有 COM/UIA/mss 调用串行化在单一 STA 线程（带消息泵）；超时「毒化」重建线程，目标窗口挂起不会拖死工具进程——桌面工具能可靠超时的关键。
2. **观察三档可降级**：`uia`（语义树紧凑快照 + ref，默认，token 最省）/ `ocr`（mss 截图 + rapidocr 文字块）/ `vlm`（降采样截图→多模态模型）；`auto` 按 UIA 探测结果降级，OCR 为空时提示显式升档（不静默，费用可见）。渐进骨架：默认深度 3 + 截断容器标 `children_count`，`--root <ref>` 局部下钻，治理密集应用 token 膨胀。
3. **ref 体系与活性校验**：观察产出 `@<快照id>:eN`（UIA 元素）/`:bN`（文字块）；动作前校验 pid+指纹+RuntimeId/矩形漂移，失效返回 `STALE_REF`，绝不盲点旧坐标——避免「对着已关闭的窗口点击」类事故。
4. **动作通道双轨**：优先 UIA 语义动作（invoke/set_value/toggle/select/scroll 等，走 Pattern **不抢焦点**）；坐标类（click/drag/type/press）走 SendInput 绝对坐标（先置前台）。键盘支持组合键 + `KEYEVENTF_UNICODE` 直打中文，长文本走剪贴板快速通道并恢复原剪贴板。
5. **execute/run 共用执行引擎**：execute 纯确定性（0 模型调用，expect 后置条件，`${var}` 白名单插值）；run 是有界 ReAct（观察→规划 1-3 步→执行→Jev done/blocked 校验→循环），规划器反复误报完成有熔断，预算硬上限（runTimeoutMs/maxSteps/maxPlannerRequests…只可缩短全局默认）。
6. **Jev 判断**：`core/judge.py` 薄 httpx 适配 TypeSafe SystemOne 协议（`POST {baseUrl}/v1/systemone`），一次请求并行问多个闭集问题（Choice 选候选 / Noul 是否判断），统一重试收口与 usage 统计；bocha/vercel/zen/custom 协议同构，一套代码覆盖全部预设，无需官方 SDK。
7. **可观测**：JSONL 动作账本（仅观测，不含值全文与 key）+ artifact 落盘 + 统一 envelope（status/steps/evidence/metrics/error），失败给可操作错误码不假装成功。
8. **MCP 传输层**：官方 `mcp` SDK 未采用（1.x→2.x 已发生 FastMCP→MCPServer 破坏性改名），改为标准库手写 JSON-RPC stdio 循环（同 server-py 做法），只依赖 tools 协议子集，零版本风险。

## 接入方式与使用步骤

两种接入方式：**CLI**（人/脚本）与 **MCP**（Agent 宿主），共享同一个 `core`，工具名/参数/输出契约一一对应。推荐先用 CLI 跑通，再接 MCP。

---

### 第 0 步：安装与自检

**① 装依赖**（Python 3.9+，仅 Windows）：

```powershell
pip install -r tools/jev-desktop/requirements.txt
# OCR 观察档（可选；不用 ocr 档可不装）
pip install -r tools/jev-desktop/requirements-ocr.txt
```

**② 自检**（在 `tools/jev-desktop/` 下）：

```powershell
python cli.py --version     # jev-desktop-cli v0.1.0
python cli.py doctor
```

`doctor` 输出逐项解读：

| 检查项 | 含义 | ✘ 时影响 |
|---|---|---|
| platform / dpi / screen | 系统、DPI 感知、分辨率 | 一般恒过 |
| uia | UIA 组件可用性 | 无法用 UIA 观察/语义动作 |
| screenshot | mss 截图通道 | 无法截图/ocr/vlm |
| ocr | rapidocr 可用 | 只影响 ocr 档（未装 requirements-ocr 属正常） |
| clipboard / elevation / session_dir | 剪贴板；是否管理员；数据目录 | 非管理员：无法对管理员窗口合成输入（UIPI） |
| jev_key / planner | Jev 与规划器凭据 | **不影响确定性动作**；只挡 `goal` 步骤与 `run` |

**不配任何 key 也能完整使用：windows / snapshot / act（非语义目标）/ execute（不含 goal 步骤）/ screenshot / clipboard。**

---

### 方式一：CLI

#### 1.1 看窗口 → 观察 → 动作（交互三步）

```powershell
# ① 列出可见顶层窗口，拿到目标
python cli.py windows
# 输出：[197112  ] chrome.exe   爱奇艺 - Google Chrome [前台]
#       [67132   ] WindowsTerminal.exe  Tool
# id 即窗口句柄；[前台] 标记当前前台窗口

# ② 观察目标窗口：产出紧凑文本树 + 可引用 ref（UIA 只读，不抢焦点）
python cli.py snapshot --title "记事本" --session work
# 输出解读：
#   # 快照 @a87a6c7e  ← 快照 id，ref 前缀
#   [@a87a6c7e:e7] Document "文本编辑器" val="..."   ← eN=UIA 元素 ref；val=当前值
#   [@a87a6c7e:e15] Tab ... 子节点=2 可下钻           ← 截断提示，用 --root 下钻
python cli.py snapshot --app notepad --root "@a87a6c7e:e15" --session work   # 局部下钻
```

选窗口三选一：`--app 进程名/pid`、`--title 标题子串`（大小写不敏感）、`--window-id 句柄`。
`--session` 给会话起名后，ref（如 `@a87a6c7e:e7`）跨命令复用；元素失效会报 `STALE_REF`，重新 snapshot 即可。

```powershell
# ③ 执行单个动作（动作分三类）
python cli.py act invoke --target "@<快照id>:e14" --session work          # UIA 语义动作：不抢焦点
python cli.py act set_value --value "新文本" --target '{"kind":"uia","controlType":"Document","name":"文本编辑器"}'
python cli.py act click --target '{"kind":"coords","x":500,"y":300}'      # 坐标动作：会置前台！
python cli.py act press --value ctrl+s --target '{"kind":"none"}'          # 全局动作：键组合
python cli.py act launch --value notepad --target '{"kind":"none"}'        # 窗口管理：close/focus/minimize/maximize/move/resize
```

动作全集：`invoke | click | double_click | right_click | hover | drag | type | set_value | press | scroll | select | toggle | check | uncheck | expand | collapse | focus | close | launch | minimize | maximize | restore | move | resize`。
TargetSpec 四种：`{"kind":"ref","ref":"@id:eN"}`（推荐）/ `{"kind":"uia",...}` / `{"kind":"coords",...}` / `{"kind":"text","target":"语义描述"}`（经 Jev，需 key）/ `{"kind":"none"}`（全局动作）。
加 `--dry-run` 只解析校验目标不执行。

#### 1.2 execute：确定性步骤（0 模型调用）

从零写一个 flow（JSON 文件）：

```jsonc
{
  "schemaVersion": 1,
  "title": "记事本",                       // 窗口范围：app / title / window_id 三选一
  "steps": [
    { "id": "w1", "kind": "action", "act": "type", "target": {"kind":"none"}, "value": "hello ${who}" },
    { "id": "w2", "kind": "wait", "mode": "time", "ms": 500 },
    { "id": "w3", "kind": "extract",                      // 读取元素 → 存变量
      "target": {"kind":"uia","controlType":"Document","name":"文本编辑器"},
      "fields": ["value"], "saveAs": "docval" },
    { "id": "w4", "kind": "assert", "op": "var_contains", "name": "docval", "value": "hello" },
    { "id": "w5", "kind": "assert", "op": "window_title_contains", "value": "记事本" },
    { "id": "w6", "kind": "screenshot", "saveAs": "final" }
  ]
}
```

要点：
- 步骤 kind：`action | wait | screenshot | extract | assert | goal`（goal 是唯一语义步骤，需 Jev key）
- 变量：`--values '{"who":"世界"}'` 传入初值；extract 的 `saveAs` 存第一个请求字段的值；`${name}` 白名单插值；敏感值 `{"secretRef":"NAME"}`（读 `JEV_DESKTOP_SECRET_<NAME>` 环境变量）
- assert 的 op：`var_equals / var_contains / var_exists / element_exists / element_gone / window_title_contains`（注意引用变量用 `name` 字段）

执行与选项：

```powershell
python cli.py execute --file my.flow.json --title "记事本" --session work
python cli.py execute --file my.flow.json --continue-on-error    # 步骤失败继续（默认失败即停）
python cli.py execute --file my.flow.json --dry-run              # 只校验步骤与目标解析
python cli.py execute --file my.flow.json --json                 # 纯 envelope JSON 输出
```

预期输出：`✔ 状态: done (耗时 …ms)` + 每步 `✔/✘ 步骤id: 动作`；失败时 stderr 给 `[错误码] 可操作信息`。

#### 1.3 run：一句话目标（自主任务，需配规划 LLM）

**前置**：配规划器（OpenAI 兼容端点）与 Jev 凭据（环境变量方式，免配置文件）：

```powershell
set JEV_DESKTOP_PLANNER_BASE_URL=https://api.deepseek.com/v1
set JEV_DESKTOP_PLANNER_MODEL=deepseek-chat
set JEV_DESKTOP_PLANNER_API_KEY=<规划模型 key>          # 默认 apiKeyEnv 指向它
set TYPESAFE_API_KEY=<Jev key>                          # provider=bocha 默认；可用 JEV_DESKTOP_JEV_* 改
python cli.py run "在记事本里写 hello 并保存" --app 记事本
python cli.py run "..." --success-criteria "[\"记事本标题包含 hello\"]"   # 可选验收条件数组
```

内部为有界 ReAct：观察 → 规划 1-3 步 → 执行 → Jev done/blocked 校验 → 循环。缺配置明确报 `PLANNER_NOT_CONFIGURED`；预算硬上限（`JEV_DESKTOP_RUN_TIMEOUT_MS / MAX_STEPS / MAX_PLANNER_REQUESTS / MAX_JEV_REQUESTS` 等，只可缩短默认值）。

#### 1.4 截图与剪贴板；输出与数据位置

```powershell
python cli.py screenshot --title "记事本"                # 默认只截目标窗口区域 → 存 artifact
python cli.py screenshot --title "记事本" --full-screen  # 整屏（可能含敏感信息）
python cli.py clipboard --op get                         # get | set --value "文本" | clear
```

| 项 | 位置 |
|---|---|
| 截图/产物 | `%LOCALAPPDATA%\AI-Redfish\jev-desktop\artifacts\` |
| 会话/ref 状态 | `%LOCALAPPDATA%\AI-Redfish\jev-desktop\sessions\` |
| 配置文件 | `%LOCALAPPDATA%\AI-Redfish\jev-desktop\config.json`（可 `--config` 指定） |

退出码：0 done；2 参数/配置错误；4 failed；130 cancelled。

#### 1.5 无 key 联调（mock server，全离线）

```powershell
# 终端 A：起 mock（OpenAI 兼容规划 + Jev SystemOne + VLM）
python tests/mock_server.py 8778

# 终端 B：指向 mock
set JEV_DESKTOP_PLANNER_BASE_URL=http://127.0.0.1:8778/v1
set JEV_DESKTOP_PLANNER_MODEL=mock-model
set JEV_DESKTOP_PLANNER_API_KEY=mock-key
set JEV_DESKTOP_JEV_PROVIDER=custom
set JEV_DESKTOP_JEV_BASE_URL=http://127.0.0.1:8778/v1
set JEV_DESKTOP_JEV_MODEL=mock-jev
set JEV_DESKTOP_JEV_API_KEY_ENV=JEV_DESKTOP_PLANNER_API_KEY
python cli.py doctor --with-network        # 联网探测应全过
```

---

### 方式二：MCP Server（8 工具）

**① 本仓库内：启动器拉起**（首次自动 `pip install` 依赖）：

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list            # 确认识别 jev-desktop（launcher.json 声明）
node bin/tool-launcher.js jev-desktop     # 以 MCP stdio 方式拉起
```

**② 或在 MCP 客户端直接注册**：

```json
{ "mcpServers": { "jev-desktop": {
    "command": "python",
    "args": ["D:/develop/GitNote/Redfish-AI/Tool/tools/jev-desktop/mcp_server.py"] } } }
```

> 路径用绝对路径；`python` 需在客户端进程 PATH 中（或写 python.exe 绝对路径）。

**③ 工具与 CLI 子命令一一对应**：

| 工具 | 关键入参 | 说明 |
|---|---|---|
| `desktop_doctor` | `with_network` | 环境诊断；联网探测会产生一次极小模型请求 |
| `desktop_windows` | — | 列窗口（id/标题/进程/前台标记） |
| `desktop_snapshot` | `app/title/window_id`, `level(uia/ocr/vlm/auto)`, `root`, `depth`, `max_elements`, `session` | 观察；`level` 缺省按配置（默认 uia/auto） |
| `desktop_act` | `action`, `target`, `value`, `session`, `dry_run` | 单动作（见 1.1 的动作全集） |
| `desktop_execute` | `steps`, `values`, `stop_on_error`, `session`, `dry_run` | FlowStep 数组（见 1.2 的格式） |
| `desktop_run` | `goal`, `success_criteria`, `app/title`, `values`, `session` | 自主任务（需 planner） |
| `desktop_screenshot` | `app/title`, `full_screen`, `return_image`, `session` | `return_image=true` 返回 MCP image 供多模态宿主直接看图 |
| `desktop_clipboard` | `op(get/set/clear)`, `value` | 剪贴板 |

**④ Agent 典型调用序列**：

```text
desktop_doctor {}                                → 自检
desktop_windows {}                               → 选目标窗口
desktop_snapshot { title: "记事本", session: "w" } → 拿 refs
desktop_act { action: "set_value", target: {...}, value: "...", session: "w" }
desktop_execute { steps: [...], title: "记事本", session: "w" }   → 批量确定性步骤
desktop_screenshot { title: "记事本", return_image: true, session: "w" }
```

安全提醒（与 CLI 相同）：坐标类动作会把窗口置前台，期间勿占用鼠标键盘；无门禁设计，动作直接执行——把工具暴露给 Agent 前确认可接受。

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

## 实机验证记录

> 2026-09-27 实现轮验证（Windows 11 + Python 3.13；全部非侵入，未占用鼠标键盘）：

| 项 | 结果 |
| --- | --- |
| 离线单元测试 `python tests/test_core.py` | ✔ 30/30 |
| `cli.py doctor`（UIA/截图/OCR/剪贴板/DPI/会话目录） | ✔ 全过（jev/planner key 未配为预期 ✘，不阻塞确定性动作） |
| `windows` 枚举真实顶层窗口 | ✔（7 窗口，含前台标记/矩形） |
| `snapshot`（商店版记事本，UIA 只读不抢焦点） | ✔ 紧凑树 + refs + 截断标记 + 可下钻提示；ValuePattern 读到文档内容 |
| `execute` 全链路（extract uia→变量→assert var_contains/window_title_contains→screenshot） | ✔ done |
| `screenshot`（窗口区域，artifact 落盘） | ✔ 1920x1049 PNG |
| `JevClient` 真实 HTTP（mock server：noul/choice/429 重试收口） | ✔ choice 正确选中目标候选；重试后成功 |
| MCP stdio（initialize + tools/list） | ✔ 8 工具注册 |
| 启动器 `node bin/tool-launcher.js list` | ✔ 识别 |

本轮修复：`cli.py --help` 崩溃（argparse help 含字面 `%` 未转义为 `%%`）。

仍待真人监督验证（涉及 SendInput/置前台，不适合无人值守执行）：
fixture_winforms 语义动作矩阵（invoke/toggle/select/set_value）、`run` 全链路（mock 规划器已验证 ReAct 循环与熔断，未在真实窗口跑输入）、P0 六应用矩阵、真实 key 联调。

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
