# jev-desktop —— Windows 桌面软件控制工具

> 基于「规划 LLM + Jev 判断」控制 Windows 桌面上的任意软件：UIA 读结构、Jev 做局部语义判断、规划 LLM 做任务拆解、UIA Pattern 与 SendInput 做动作。MCP 与 CLI 共享同一份 `core`。版本 `0.1.0`，仅 Windows。

## 技术原理

### 分层与调用链（谁调用谁）

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

CLI 子命令与 MCP 工具一一对应（`desktop_` 前缀去掉即子命令名），参数、校验、输出契约同源——`core/tooldata.py` 的 TOOLS 元数据是单一事实来源，适配器只做协议/参数翻译，不含业务。

### 两种入口模式与执行引擎的关系（易混点，重点）

| 入口 | 输入 | 内部流程 | 模型调用 |
|---|---|---|---|
| `execute` | 明确步骤数组 | 纯确定性执行引擎逐步执行 | **默认 0 次**；唯一例外是 `goal` 步骤（见下） |
| `run` | 一句话目标 | **有界 ReAct 循环**：观察 → 规划 LLM 产 1-3 步 → 执行 → Jev done/blocked 校验 → 循环，直到完成/阻塞/预算耗尽 | 每轮 1 次规划 + Jev 校验 |

与 jev-browser 的关键区别：**desktop 的 `run` 本身就是一个循环**（规划器每轮只拆 1-3 步，执行后由 Jev 校验再决定下一轮），而不是"规划器一次性产完整计划再执行"。两者共用同一执行引擎与输出契约；调用者显式选择入口，工具不用模型猜。

- `goal` 步骤（execute 内）：唯一的语义步骤，进入 Jev 局部循环（在候选元素中做闭集选择）；需 Jev key，缺 key 报 `JEV_NOT_CONFIGURED`。
- `run` 缺规划器配置报 `PLANNER_NOT_CONFIGURED`，不自动猜；规划器反复误报完成有熔断；预算硬上限（runTimeoutMs/maxSteps/maxPlannerRequests/maxJevRequests…，任务级只可缩短全局默认）。

### 专用 UIA 工作线程（桌面工具能可靠超时的关键）

所有 COM/UIA/mss 调用串行化在单一 STA 线程（带消息泵）；任何调用超时则「毒化」该线程并重建——目标窗口挂起（无响应）不会拖死工具进程，观察/动作都能按超时返回错误而不是卡死。

### 观察通道：三档可降级 + 渐进骨架 + ref 活性校验

1. **三档**：`uia`（UIA 语义树紧凑快照，默认，token 最省）/ `ocr`（mss 截图 + rapidocr 文字块）/ `vlm`（降采样截图 → 多模态模型）；`auto` 按 UIA 探测结果降级，OCR 为空时**提示显式升档**（不静默产生费用）。
2. **渐进骨架**：默认深度 3，截断容器只标 `children_count`；`--root <ref>` 从某元素局部下钻——治理密集应用（IDE/浏览器）的 token 膨胀。
3. **ref 体系**：快照产出 `@<快照id>:eN`（UIA 元素）/`:bN`（文字块）。动作引用 ref 前做**活性校验**（pid + 指纹 + RuntimeId/矩形漂移），失效返回 `STALE_REF`，**绝不盲点旧坐标**——避免「对着已关闭的窗口点击」类事故。ref 在会话内跨命令复用。

### 动作通道：双轨，优先不抢焦点

| 通道 | 动作 | 特点 |
|---|---|---|
| UIA 语义（Pattern） | invoke/set_value/toggle/check/uncheck/select/expand/collapse/scroll/focus | **不抢焦点**，后台可执行 |
| SendInput 坐标 | click/double_click/right_click/hover/drag | 绝对坐标，**先把窗口置前台**（期间勿动鼠标键盘） |
| 键盘 | type（`KEYEVENTF_UNICODE` 直打中文；长文本走剪贴板快速通道并恢复原剪贴板）、press（组合键） | — |
| 窗口管理 | launch/close/minimize/maximize/restore/move/resize | — |
| 剪贴板 | clipboard_get/clipboard_set | UTF-8 文本 |

### Jev 判断与可观测

- `core/judge.py` 薄 httpx 适配 TypeSafe SystemOne 协议（`POST {baseUrl}/v1/systemone`）：一次请求**并行**问多个闭集问题（Choice 选候选 / Noul 是否判断），统一重试收口与 usage 统计；provider 预设 bocha/typesafe/vercel/zen/custom 协议同构，一套代码覆盖。
- JSONL 动作账本（仅观测动作，不含值全文与 key）+ artifact 落盘 + 统一 envelope（status/result/error/metrics/evidence）；失败给可操作错误码，不假装成功。
- `winapi.py` 是纯 ctypes 原生层（SendInput/窗口/剪贴板/DPI），不依赖第三方包；MCP 传输层为标准库手写 JSON-RPC stdio（规避官方 SDK 1.x→2.x 破坏性改名），只依赖 tools 协议子集。

---

## 使用步骤

### 步骤 0：安装与自检（uv）

前置：仅 Windows；Python ≥3.9（由 uv 托管）；先安装 [uv](https://docs.astral.sh/uv/)。以下命令在 `tools/jev-desktop/` 下执行：

```powershell
uv sync                      # 创建 .venv 并安装基础依赖（uiautomation/mss/Pillow/httpx，声明在 pyproject.toml）
uv sync --extra ocr          # OCR 观察档（可选；不装则 ocr 档返回 OCR_UNAVAILABLE，auto 档自动跳过）

uv run cli.py --version      # jev-desktop-cli v0.1.0
uv run cli.py doctor         # 自检（MCP 经启动器首次拉起时也会自动 uv sync）
```

doctor 逐项解读：

| 检查项 | 含义 | ✘ 时影响 |
|---|---|---|
| platform / dpi / screen | 系统、DPI 感知、分辨率 | 一般恒过 |
| uia / screenshot | UIA 组件 / mss 截图通道 | 无法观察与语义动作 / 无法截图 |
| ocr | rapidocr 可用 | 只影响 ocr 档（未 `--extra ocr` 属正常） |
| clipboard / elevation / session_dir | 剪贴板 / 是否管理员 / 数据目录 | 非管理员无法对管理员窗口合成输入（UIPI） |
| jev_key / planner | Jev 与规划器凭据 | **不影响确定性动作**；只挡 `goal` 步骤与 `run` |

**不配任何 key 也能完整使用：windows / snapshot / act（非语义目标）/ execute（不含 goal 步骤）/ screenshot / clipboard。**

### 步骤 1：配置

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

key 一律经环境变量（`apiKeyEnv` 指向），配置文件不落真实 key。Jev provider 预设：`bocha`（默认）/ `typesafe` / `vercel` / `zen` / `custom`。

| 项 | 位置 |
|---|---|
| 截图/产物 | `%LOCALAPPDATA%\AI-Redfish\jev-desktop\artifacts\` |
| 会话/ref 状态 | `%LOCALAPPDATA%\AI-Redfish\jev-desktop\sessions\` |
| 配置文件 | `%LOCALAPPDATA%\AI-Redfish\jev-desktop\config.json`（`--config` 指定） |
| 虚拟环境 | 工具目录 `.venv\`（uv 托管，`uv.lock` 锁定） |

### 步骤 2：CLI 使用

入口：`uv run cli.py <子命令> [参数...]`（下文示例省略 `uv run`；子命令也可用 `desktop_` 全名，如 `desktop_snapshot` ≡ `snapshot`）。

**全局参数**（任意位置可用）：

| 参数 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `--config <path>` | string | 见步骤 1 | 配置文件路径 |
| `--json` | 旗标 | 关 | 禁交互，stdout 输出纯 envelope JSON |
| `--dry-run` | 旗标 | 关 | 只观察/解析/校验，不执行动作 |
| `--session <id>` | string | `default` | 会话 id；ref 跨命令复用 |
| `--timeout <ms>` | integer | 配置 runTimeoutMs | run 超时（只可缩短全局默认） |

**子命令总览**：

| 子命令 | 必填参数 | 作用 |
|---|---|---|
| `list` / `--version` / `-h` | — | 工具清单 / 版本 / 帮助 |
| `doctor` | — | 环境诊断（`--with-network` 联网探测） |
| `windows` | — | 列出可见顶层窗口 |
| `snapshot` | 窗口三选一（缺省取会话最近/前台） | 观察目标窗口，产出快照 + refs |
| `act` | `action`（可位置式） | 单个动作 |
| `execute` | `steps`（常用 `--file`） | 确定性步骤数组 |
| `run` | `goal`（可位置式） | 一句话目标（需 planner） |
| `screenshot` | 窗口三选一 | 截图存 artifact |
| `clipboard` | `op` | 剪贴板读写清 |

**复杂参数（object/array）三种写法**：内联 JSON（`--steps '[{...}]'`）、`@文件路径`（`--steps @flow.json`）、直接给 `.json` 后缀路径；不支持 `-`（stdin）。`--target` 额外兼容 ref 简写（`--target @a87a6c7e:e7`）。带下划线的旗标同时接受连字符形式（`--max-elements` ≡ `--max_elements`）。

#### 2.1 看窗口 → 观察 → 动作（交互三步）

```powershell
# ① 列出可见顶层窗口，拿到目标
cli windows
# 输出：[197112  ] chrome.exe   爱奇艺 - Google Chrome [前台]
#       [67132   ] WindowsTerminal.exe  Tool
# id 即窗口句柄；[前台] 标记当前前台窗口

# ② 观察目标窗口（UIA 只读，不抢焦点）
cli snapshot --title "记事本" --session work
# 输出解读：
#   # 快照 @a87a6c7e  ← 快照 id，ref 前缀
#   [@a87a6c7e:e7] Document "文本编辑器" val="..."   ← eN=UIA 元素 ref；val=当前值
#   [@a87a6c7e:e15] Tab ... 子节点=2 可下钻           ← 截断提示，用 --root 下钻
cli snapshot --app notepad --root "@a87a6c7e:e15" --session work   # 局部下钻
```

**`snapshot` 参数全表**：

| 参数 | 类型 | 必填 | 默认 | 作用 |
|---|---|---|---|---|
| `--app` | string | 三选一 | 会话最近窗口→前台窗口 | 进程名（notepad）/ pid / 标题子串 |
| `--title` | string | 三选一 | — | 窗口标题子串（大小写不敏感），比 app 更精确 |
| `--window-id` | integer | 三选一 | — | 顶层窗口句柄（`windows` 输出的 id） |
| `--level` | string | 否 | 配置 observation.level（默认 auto） | `auto` / `uia` / `ocr` / `vlm` |
| `--root` | string | 否 | — | 从某个 UIA ref 局部下钻 |
| `--depth` | integer | 否 | 配置 maxDepth=3 | UIA 遍历深度 |
| `--max-elements` | integer | 否 | 配置 maxElements=800 | 元素数上限 |
| `--save-artifact` | 旗标 | 否 | false | 截图存 artifact（ocr/vlm 档自动保存） |
| `--session` | string | 否 | `default` | 会话 id |

**`act` 参数全表**：

| 参数 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `action`（可位置式第 1 位） | string | 是 | 动作名（25 个全集见下） |
| `--target` | TargetSpec | 否 | 目标对象；省略 = 全局动作（press/launch/窗口管理/剪贴板） |
| `--value`（可位置式第 2 位） | string | 否 | `type`=文本；`press`=键组合（ctrl+s）；`scroll`=down\|up\|left\|right[:次数]；`move`=x,y；`resize`=w,h；`select`=选项文本；`clipboard_set`=内容；`drag`=x2,y2 终点坐标 |
| `--app` / `--title` / `--window-id` | — | 三选一 | 窗口范围 |
| `--session` / `--dry-run` | — | 否 | 会话 / 只校验不执行 |

**动作全集（25 个）**：

| 通道 | 动作 | 抢焦点？ |
|---|---|---|
| UIA 语义 | `invoke` `set_value` `toggle` `check` `uncheck` `select` `expand` `collapse` `scroll` `focus` | 否 |
| SendInput 坐标 | `click` `double_click` `right_click` `hover` `drag` | 是（先置前台） |
| 键盘 | `type` `press` | 视目标 |
| 窗口管理 | `launch` `close` `minimize` `maximize` `restore` `move` `resize` | — |
| 剪贴板 | `clipboard_get` `clipboard_set`（配 `--value`） | 否 |

**TargetSpec 五种**：

| kind | 写法 | 说明 |
|---|---|---|
| `ref` | `{"kind":"ref","ref":"@<快照id>:eN"}`（CLI 可简写 `--target @id:eN`） | **推荐** |
| `uia` | `{"kind":"uia","controlType":"Button","name":"保存","automationId":"btn-save","index":0}` | 属性匹配（字段可组合） |
| `coords` | `{"kind":"coords","x":500,"y":300}` | 物理像素绝对坐标 |
| `text` | `{"kind":"text","target":"搜索框"}` | 语义描述，经 Jev 选候选（需 key） |
| `none` | `{"kind":"none"}` | 全局动作 |

```powershell
cli act invoke --target "@<快照id>:e14" --session work          # UIA 语义动作：不抢焦点
cli act set_value --value "新文本" --target '{"kind":"uia","controlType":"Document","name":"文本编辑器"}'
cli act click --target '{"kind":"coords","x":500,"y":300}'      # 坐标动作：会置前台！
cli act press --value ctrl+s --target '{"kind":"none"}'          # 全局动作：键组合
cli act launch --value notepad --target '{"kind":"none"}'        # 窗口管理
```

#### 2.2 execute：确定性步骤（0 模型调用）

flow 文件示例：

```jsonc
{
  "schemaVersion": 1,
  "title": "记事本",                       // 窗口范围：app / title / window_id 三选一（flow 顶层自动提取为窗口参数）
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

- 步骤 kind：`action | wait | screenshot | extract | assert | goal`（goal 是唯一语义步骤，需 Jev key）
- 变量：`--values '{"who":"世界"}'` 传初值；extract 的 `saveAs` 存值；`${name}` 白名单插值；敏感值 `{"secretRef":"NAME"}`（读 `JEV_DESKTOP_SECRET_<NAME>`）
- assert 的 op：`var_equals / var_contains / var_exists / element_exists / element_gone / window_title_contains`（引用变量用 `name` 字段）

**`execute` 参数全表**：

| 参数 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `--steps` / `--file` | array | 是 | FlowStep 数组（三种写法）；`--file` 是 `--steps @file` 别名；给完整 flow 对象时自动拆包并把顶层 app/title/window_id 提取为窗口范围 |
| `--values` | object | 否 | 变量初值 |
| `--continue-on-error` | 旗标 | 否 | 步骤失败继续（默认失败即停） |
| `--app` / `--title` / `--window-id` | — | 三选一 | 窗口范围（命令行优先于 flow 顶层） |
| `--session` / `--dry-run` | — | 否 | 会话 / 只校验 |

```powershell
cli execute --file my.flow.json --title "记事本" --session work
cli execute --file my.flow.json --continue-on-error
cli execute --file my.flow.json --dry-run              # 只校验步骤与目标解析
cli execute --file my.flow.json --json                 # 纯 envelope JSON
# 预期输出：✔ 状态: done (耗时 …ms) + 每步 ✔/✘；失败时 stderr 给 [错误码] 可操作信息
```

#### 2.3 run：一句话目标（需配规划 LLM）

```powershell
set JEV_DESKTOP_PLANNER_BASE_URL=https://api.deepseek.com/v1
set JEV_DESKTOP_PLANNER_MODEL=deepseek-chat
set JEV_DESKTOP_PLANNER_API_KEY=<规划模型 key>
set TYPESAFE_API_KEY=<Jev key>                          # provider=bocha 默认；可用 JEV_DESKTOP_JEV_* 改
```

**`run` 参数全表**：

| 参数 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `goal`（可位置式） | string | 是 | 自然语言目标 |
| `--success-criteria` | array | 否 | 验收条件（自然语言 JSON 数组）；缺省按「goal 的直接可观察结果」处理并标注未配置验收 |
| `--app` / `--title` / `--window-id` | — | 三选一 | 窗口范围 |
| `--values` | object | 否 | 供步骤引用的变量初值 |
| `--session` | string | 否 | 会话 id |

```powershell
cli run "在记事本里写 hello 并保存" --app 记事本
cli run "..." --success-criteria "[\"记事本标题包含 hello\"]"
```

#### 2.4 截图与剪贴板

**`screenshot`**：窗口三选一 + `--full-screen`（整屏，可能含敏感信息）+ `--return-image`（返回内嵌图像，MCP 下默认 true）+ `--session`。
**`clipboard`**：`--op`（get/set/clear，必填）+ `--value`（set 时需要）。
**`doctor`**：`--with-network` 旗标（联网探测，产生一次极小模型请求）。

```powershell
cli screenshot --title "记事本"                # 默认只截目标窗口区域 → artifact
cli screenshot --title "记事本" --full-screen  # 整屏
cli clipboard --op get                         # get | set --value "文本" | clear
```

#### 2.5 envelope 字段说明（`--json` 输出）

| 字段 | 含义 |
|---|---|
| `status` | `done` / `failed` / `cancelled` |
| `result` | 各命令的结果体（windows=窗口表；snapshot=快照 id+text+refs+image；screenshot=path/宽高；doctor=checks；execute=steps 逐条；clipboard=text） |
| `error` | `{code, message, details?}`（常见码：`INVALID_PARAMS/CONFIG_INVALID/INVALID_STEP/ASSERT_FAILED/STALE_REF/GOAL_BLOCKED/PLANNER_NOT_CONFIGURED/JEV_NOT_CONFIGURED`） |
| `metrics` | `elapsedMs/jevRequests/plannerRequests/actions/tokens{input,output}` |
| `evidence` | 截图/概率等证据明细 |

#### 2.6 退出码与排错

| 码 | 含义 |
|---|---|
| 0 | done |
| 2 | 参数/配置错误（`INVALID_PARAMS` / `CONFIG_INVALID` / `INVALID_STEP`） |
| 4 | failed（及其它错误码） |
| 130 | cancelled（Ctrl+C 协作取消：当前步骤完成后返回） |

常见问题：`STALE_REF` → 窗口变了，重新 snapshot 拿新 ref；`PLANNER_NOT_CONFIGURED` → 配规划器（2.3）；语义目标报 `JEV_NOT_CONFIGURED` → 配 Jev key；管理员窗口无法输入（UIPI）→ 以管理员运行工具。

安全注意：所有动作直接执行**无门禁**（`--dry-run` 仅观测不拦截）；坐标动作期间会把窗口置前台，勿占用鼠标键盘；快照文本/OCR/截图（vlm 档）会发送到所配置的 Jev/规划器/VLM 端点；锁屏/RDP 断开后截图与输入失效。

#### 2.7 无 key 联调（mock，全离线）

```powershell
# 终端 A：起 mock（OpenAI 兼容规划 + Jev SystemOne + VLM）
uv run tests/mock_server.py 8778

# 终端 B：指向 mock
set JEV_DESKTOP_PLANNER_BASE_URL=http://127.0.0.1:8778/v1
set JEV_DESKTOP_PLANNER_MODEL=mock-model
set JEV_DESKTOP_PLANNER_API_KEY=mock-key
set JEV_DESKTOP_JEV_PROVIDER=custom
set JEV_DESKTOP_JEV_BASE_URL=http://127.0.0.1:8778/v1
set JEV_DESKTOP_JEV_MODEL=mock-jev
set JEV_DESKTOP_JEV_API_KEY_ENV=JEV_DESKTOP_PLANNER_API_KEY
cli doctor --with-network        # 联网探测应全过
cli run "在控制台输出 RUN-OK-MOCK" --title "目标窗口" --session smoke
```

mock 特殊标记：goal 含 `BLOCKED-TEST`/`BADJSON-TEST`/`NOTDONE-TEST`/`RETRY-TEST` 分别验证 GOAL_BLOCKED/规划校验失败/预算熔断/429 重试。

### 步骤 3：MCP 使用（Agent 宿主，8 工具）

① 本仓库内经启动器拉起（首次自动 `uv sync`；launcher.json 声明 `uv run mcp_server.py`，自动复用工具目录 .venv）：

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list            # 确认识别
node bin/tool-launcher.js jev-desktop     # 以 MCP stdio 拉起
```

② 或在 MCP 客户端直接注册：

```json
{ "mcpServers": { "jev-desktop": {
    "command": "uv",
    "args": ["run", "--directory", "D:/develop/GitNote/Redfish-AI/Tool/tools/jev-desktop", "mcp_server.py"] } } }
```

> `--directory` 指向工具目录（客户端工作目录通常不在工具目录，uv 需据此定位 pyproject/.venv）；`uv` 需在客户端 PATH 中。

③ 8 个工具与参数全表（与 CLI 子命令一一对应，参数即 2.x 各表的 snake_case 命名）：

| 工具 | 参数（粗体必填） | 说明 |
|---|---|---|
| `desktop_doctor` | `with_network?`（boolean） | 环境诊断 |
| `desktop_windows` | — | 列窗口（id/标题/进程/矩形/前台标记） |
| `desktop_snapshot` | 窗口三选一、`level?`（uia/ocr/vlm/auto）、`root?`、`depth?`、`max_elements?`、`save_artifact?`、`session?` | 观察；level 缺省按配置 |
| `desktop_act` | **`action`**、`target?`、`value?`、窗口三选一、`session?`、`dry_run?` | 单动作（25 个全集见 2.1） |
| `desktop_execute` | **`steps`**、`values?`、`stop_on_error?`（默认 true）、窗口三选一、`session?`、`dry_run?` | 确定性步骤（格式见 2.2） |
| `desktop_run` | **`goal`**、`success_criteria?`（string[]）、窗口三选一、`values?`、`session?` | 自主任务（需 planner） |
| `desktop_screenshot` | 窗口三选一、`full_screen?`、`return_image?`（默认 true）、`session?` | `return_image=true` 返回 MCP image |
| `desktop_clipboard` | **`op`**（get/set/clear）、`value?` | 剪贴板 |

④ Agent 典型调用序列：

```text
desktop_doctor {}                                → 自检
desktop_windows {}                               → 选目标窗口
desktop_snapshot { title: "记事本", session: "w" } → 拿 refs
desktop_act { action: "set_value", target: {...}, value: "...", session: "w" }
desktop_execute { steps: [...], title: "记事本", session: "w" }
desktop_screenshot { title: "记事本", return_image: true, session: "w" }
```

安全提醒（与 CLI 相同）：坐标动作会置前台；无门禁设计——把工具暴露给 Agent 前确认可接受。
