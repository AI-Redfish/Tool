# 兼容性与实机验证记录（P0 交付物）

> 本文档记录 jev-browser 在真实 Windows 环境的验证结果与剩余待验证项。
> 生成于 2026-09-27 实现轮；全部结果来自本机实测，可按「复现步骤」重跑。

## 1. 验证环境

| 项 | 值 |
| --- | --- |
| OS | Windows（本机） |
| Node | v24.14.1（满足 ≥24，node:sqlite） |
| Chrome（品牌版） | 154.0.8037.57（≥144，支持 `chrome://inspect/#remote-debugging` 原生授权） |
| Edge | 154.0.4258.37 |
| Playwright | 1.63.0（chromium revision 1243 + chromium-headless-shell 1243，已就位） |
| 工作区 | npm install + npm run build 通过；62 个离线单元/集成测试全绿 |

## 2. 已验证（go）

### 2.1 launch 路径端到端（受管 Chromium，无头，独立临时 profile）

复现：`node scripts/smoke.mjs`（本地 fixture HTTP 服务 + 临时 profile + 临时 dataDir，绝不触碰用户 Chrome）。

| 检查项 | 结果 |
| --- | --- |
| launchPersistentContext 启动受管 Chromium（无头 + chromiumSandbox） | ✔ |
| createSession（新页导航，授权域校验） | ✔ |
| execute 全流程：navigate → extract(role 定位) → assert(var_equals) → click 下载 → screenshot | ✔ done |
| 纯确定性流程模型调用为 0（plannerRequests=0, jevRequests=0） | ✔ |
| 下载保真：download 事件 → saveAs 受管 artifact 区 → 取回内容逐字节一致 | ✔ |
| 截图 artifact 落盘 | ✔ |
| 幂等：同 Idempotency-Key 重放返回原任务 | ✔ |
| disconnect 清理 | ✔ |

### 2.2 三入口

| 入口 | 结果 |
| --- | --- |
| CLI（doctor/help/execute 全链路） | ✔ |
| MCP（stdio initialize + tools/list，14 工具注册） | ✔ |
| 启动器 `node bin/tool-launcher.js list` 识别 | ✔ |

### 2.3 失败路径诊断（attach 未授权时）

`doctor --connect` 在 Chrome 未开启原生授权时给出可操作错误（含 Chrome 版本要求与授权入口指引），
不静默切换浏览器、不重试绕过 → 符合「授权失败明确报错」门槛（P0 退出门槛 #2）。

### 2.4 实测发现并修复的缺陷

| 缺陷 | 修复 |
| --- | --- |
| 只读动作（screenshot/scroll/wait）无 `expect` 时执行器崩溃（`step.expect.some` INTERNAL），与校验器「仅写操作强制 expect」不一致 | `executor.ts` 改为 `(step.expect ?? []).some(...)` |
| 产物只写盘不登记：`store.putArtifact` 从未被调用 → `listArtifacts`/`artifact get`/MCP/HTTP 产物链路恒为空，过期回收也取不到 path | `taskservice.ts` 给 sink 包登记层，保存后原子写入 artifacts 表（含 path/sha256/createdAt） |

## 3. 待验证（P0 剩余项，需要用户参与或专项环境）

| 项 | 阻塞原因 |
| --- | --- |
| attach 接管日常 Chrome（原生授权流、登录态可见、未选页对话框非干扰、断开保真） | 需要用户在 Chrome `chrome://inspect/#remote-debugging` 界面人工授权；本机 9222 端口探测到 404（非 CDP 服务占用），channel 发现与 DevToolsActivePort 备用路径均待真实授权后复核 |
| 断连保护矩阵（任务中途 Chrome 被关/崩溃/授权撤销） | 依赖 attach 接管成立 |
| download 断开后 artifact 完整性（attach 语义） | 同上 |
| 真实模型（Jev/规划器）联调与 P6 基准 | 需要真实 key 与预算，属显式授权测试 |

## 4. 结论

- **launch 路径（本工具管理的 Chromium）**：可用，端到端冒烟通过（go）。
- **attach 路径（接管日常 Chrome）**：保持「待验证」，README/能力表不变更承诺；
  P0 退出门槛 #1（重复 10 次连接/观察/断开）尚未执行。
- 三入口契约一致（CLI/MCP/HTTP 共用 core），离线测试 + 冒烟全绿。
