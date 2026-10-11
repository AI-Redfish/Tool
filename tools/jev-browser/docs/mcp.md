# 注册（嵌入模式）

MCP 进程内直接跑 Runtime；路径必须绝对且指向构建产物：

```json
{
  "mcpServers": {
    "jev-browser": {
      "command": "node",
      "args": ["D:/develop/GitNote/Redfish-AI/Tool/tools/jev-browser/mcp/dist/index.js"]
    }
  }
}
```

# （可选）API 转发模式

先起长驻 API（见 [长驻 HTTP API 使用](api.md)），再给 MCP 进程加环境变量——多客户端共享同一次浏览器连接：

```json
{
  "env": {
    "JEV_BROWSER_API_URL": "http://127.0.0.1:3737",
    "JEV_BROWSER_API_TOKEN": "<token>"
  }
}
```

# 14 个工具与参数全表

描述末尾带风险标签 readonly/write/control；执行错误返回 `{error:{code,message}}` + `isError:true`；execute/run/act 阻塞到任务落定，上限 30 分钟：

| 工具 | 参数（粗体必填） | 说明 |
|---|---|---|
| `browser_doctor` | `connect?`（boolean） | 诊断；true=尝试接管【readonly】 |
| `browser_connect` | `url?`/`pageId?`（二选一）、**`allowedOrigins`**（string[]）、`modelOrigins?` | 建会话【control】 |
| `browser_pages` | **`sessionId`** | 列标签页【readonly】 |
| `browser_select_page` | **`sessionId`** **`pageId`** | 切页【control】 |
| `browser_snapshot` | **`sessionId`**、`forModel?` | 快照【readonly】 |
| `browser_execute` | **`sessionId`** **`steps`**（FlowStep[]）、`values?` | 确定性步骤【write】 |
| `browser_run` | **`sessionId`** **`goal`** **`successCriteria`**、`values?` | 自主任务【write】 |
| `browser_act` | **`sessionId`** **`step`**、`values?` | 单步动作【write】 |
| `browser_task_get` | **`taskId`** | 查询【readonly】 |
| `browser_task_cancel` | **`taskId`** **`requestId`**、`expectedRevision?` | 取消【control】 |
| `browser_task_resume` | **`taskId`** **`requestId`**、`expectedRevision?`、`rerunConfirmed?`、`allowReplan?` | 恢复【control】 |
| `browser_task_approve` | **`taskId`** **`grant`** | 审批【control】 |
| `browser_artifact_get` | **`taskId`** | 产物元信息【readonly】 |
| `browser_disconnect` | **`sessionId`**、`detachTask?` | 断开【control】 |

# Agent 典型调用序列

```text
browser_doctor {}                                          → 自检
browser_connect { url, allowedOrigins: ["https://..."] }   → 建会话（allowedOrigins 必填！）
browser_snapshot { sessionId }                             → 只读观察
browser_execute { sessionId, steps: [...], values: {} }    → 确定性步骤
browser_artifact_get { taskId }                            → 列产物
browser_disconnect { sessionId }                           → 收尾（暂停任务需 detachTask:true）
```

# MCP 进程环境变量

所有 `JEV_BROWSER_*` 覆盖均生效；转发模式加 `JEV_BROWSER_API_URL/TOKEN`。

# 仓库启动器（统一 MCP 入口）

```powershell
cd D:\develop\GitNote\Redfish-AI\Tool
node bin/tool-launcher.js list                # 应列出 jev-browser
node bin/tool-launcher.js build jev-browser   # 只装依赖并构建
node bin/tool-launcher.js jev-browser         # 以 MCP stdio 拉起（缺 dist 自动构建）
```
