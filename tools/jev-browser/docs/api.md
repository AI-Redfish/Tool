## 启动

token 必须设置，否则拒绝启动：

```powershell
$env:JEV_BROWSER_API_TOKEN = "<随机长串>"
node api/dist/index.js --config "D:\config\jev-browser.json" --port 3737    # 默认 127.0.0.1:3737
```

启动参数：`--config <path>`、`--port <n>`（默认取配置 `api.port`；host 固定取配置 `api.host`，仅 loopback）。

安全基线：loopback + Bearer token + Host 校验（防 DNS rebinding）+ 无 CORS + 请求体 1MB 上限 + 写请求限速（默认 120/分）+ 并发上限（默认 16）+ artifact 下载 200MB 上限。

## 路由总表

均需 `-H "Authorization: Bearer <token>"`：

| 方法与路径 | 请求体 | 响应 | 对应 CLI/MCP |
|---|---|---|---|
| `GET /v1/diagnostics` | — | 200 doctor | doctor / browser_doctor |
| `POST /v1/sessions` | `{target, allowedOrigins, modelOrigins}` | 201 会话 | connect |
| `GET /v1/sessions/:id/pages` | — | 200 `{pages}` | pages |
| `POST /v1/sessions/:id/page` | `{pageId}` | 200 | select-page |
| `POST /v1/sessions/:id/snapshot` | `{forModel, viewportOnly?, maxElements?, filter?, roles?}` | 200 快照 | snapshot |
| `POST /v1/sessions/:id/act` | `{step, values}` | 202 任务 | act |
| `POST /v1/sessions/:id/judge` | `{question}` | 200 `{p, url, model}` | judge |
| `POST /v1/tasks/execute` | `{sessionId, steps, values}`（可加 `Idempotency-Key` 头） | 202 任务 | execute |
| `POST /v1/tasks/run` | `{sessionId, goal, successCriteria, values}` | 202 任务 | run |
| `GET /v1/tasks/:id` | — | 200 `{envelope}` | task get |
| `GET /v1/tasks/:id/artifacts` | — | 200 `{artifacts}` | artifact list |
| `GET /v1/tasks/:id/artifacts/:artifactId` | — | 200 二进制流 | artifact get |
| `POST /v1/tasks/:id/cancel` | `{requestId, expectedRevision?}` | 200 `{envelope}` | task cancel |
| `POST /v1/tasks/:id/resume` | `{requestId, expectedRevision?, rerunConfirmed?, allowReplan?}` | 200 | task resume |
| `POST /v1/tasks/:id/approve` | `{grant}` | 200 | task approve |
| `DELETE /v1/sessions/:id?detachTask=true` | — | 200 | disconnect |

错误码→HTTP 状态：`NOT_FOUND`→404；`IDEMPOTENCY_CONFLICT`/`REVISION_CONFLICT`/`SESSION_BUSY`/`BROWSER_BUSY`/`TASK_NOT_RESUMABLE`/`NEEDS_CONFIRMATION`/`SESSION_NOT_READY`/`PAGE_NOT_RESOLVED`→409；`CONFIG_INVALID`/`INVALID_INPUT`→400；`GRANT_INVALID`/`ORIGIN_NOT_ALLOWED`/`POLICY_BLOCKED`→403；限速/并发→429；其余→500。202 提交后轮询 `GET /v1/tasks/:id` 至终态。

## curl 最小闭环

```powershell
curl http://127.0.0.1:3737/v1/diagnostics -H "Authorization: Bearer <token>"
curl -X POST http://127.0.0.1:3737/v1/sessions -H "Authorization: Bearer <token>" -H "content-type: application/json" `
  -d '{ "target": {"kind":"new","url":"https://example.com"}, "allowedOrigins": ["https://example.com"] }'
curl -X POST http://127.0.0.1:3737/v1/tasks/execute -H "Authorization: Bearer <token>" -H "content-type: application/json" `
  -d '{ "sessionId":"sXX", "steps":[...], "values":{} }'
curl http://127.0.0.1:3737/v1/tasks/<taskId> -H "Authorization: Bearer <token>"     # 轮询至终态
```

CLI 侧等价：任何命令加 `--api http://127.0.0.1:3737` 即自动走转发路径（见 [CLI 命令行参考 · 全局参数](cli.md)）。

## MCP 转发模式

MCP 进程也可改为转发到本 API（多客户端共享同一次浏览器连接），见 [MCP 使用 · 注册](mcp.md)。
