#!/usr/bin/env node
/**
 * @ai-redfish/jev-browser-mcp —— MCP 适配器（stdio）
 *
 * 只做协议注册：zod schema + handler 转发 core；工具名/描述复用 core TOOLS。
 * stdout 是 MCP 协议通道；本文件所有日志写 stderr。
 *
 * 长驻模式（可选）：环境变量 JEV_BROWSER_API_URL + JEV_BROWSER_API_TOKEN 时，
 * 所有调用转发到本地长驻 API（多客户端共享一次 CDP 连接，DESIGN §9.2）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ApiClient,
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  Runtime,
  loadConfig,
  runDoctor,
  type TaskEnvelope,
} from '@ai-redfish/jev-browser-core';

const apiMode = Boolean(process.env.JEV_BROWSER_API_URL && process.env.JEV_BROWSER_API_TOKEN);

const api = apiMode
  ? new ApiClient({ baseUrl: process.env.JEV_BROWSER_API_URL!, token: process.env.JEV_BROWSER_API_TOKEN! })
  : null;

let runtime: Runtime | null = null;
async function rt(): Promise<Runtime> {
  if (!runtime) {
    const { config } = loadConfig();
    runtime = new Runtime(config);
    const recovery = runtime.recoverOnStartup();
    console.error(`[jev-browser-mcp] 崩溃恢复: ${recovery.recovered} 个遗留任务转为暂停，${recovery.expired} 个过期${recovery.isolated ? '；存在未知在途动作，已隔离' : ''}`);
  }
  return runtime;
}

const originSchema = z.array(z.string()).describe('http/https origin 列表，如 ["https://example.com"]');

/** 工具描述统一附加风险标签（DESIGN §3：TOOLS 携带风险标签）。 */
const desc = (i: number) => `${TOOLS[i].description}【风险: ${TOOLS[i].risk}】`;

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function textErr(e: unknown) {
  const errObj = e as { code?: string; message?: string };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: errObj.code ?? 'INTERNAL', message: errObj.message ?? String(e) } }, null, 2) }],
    isError: true,
  };
}

server.tool('browser_doctor', desc(0), { connect: z.boolean().optional().describe('尝试接管（需 Chrome 授权）') }, async ({ connect }) => {
  try {
    if (api) return text(await api.diagnostics());
    const result = await runDoctor({ attemptConnect: connect ?? false });
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_connect', desc(1), {
  url: z.string().optional(),
  pageId: z.string().optional(),
  allowedOrigins: originSchema,
  modelOrigins: z.array(z.string()).optional().describe('允许云模型外发的 origin；必须 ⊆ allowedOrigins；空 = 默认禁止外发'),
}, async ({ url, pageId, allowedOrigins, modelOrigins }) => {
  try {
    const input = { target: url ? { kind: 'new', url } : { kind: 'existing', pageId }, allowedOrigins, modelOrigins: modelOrigins ?? [] };
    const result = api ? await api.createSession(input) : await (await rt()).createSession(input as never);
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_pages', desc(2), { sessionId: z.string() }, async ({ sessionId }) => {
  try {
    const result = api ? await api.pages(sessionId) : await (await rt()).listPages(sessionId);
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_select_page', desc(3), { sessionId: z.string(), pageId: z.string() }, async ({ sessionId, pageId }) => {
  try {
    const result = api ? await api.selectPage(sessionId, pageId) : await (await rt()).selectPage(sessionId, pageId);
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_snapshot', desc(6), { sessionId: z.string(), forModel: z.boolean().optional().describe('true = 打算发给云模型，要求 origin ∈ modelOrigins') }, async ({ sessionId, forModel }) => {
  try {
    const obs = api ? await api.snapshot(sessionId, forModel) : await (await rt()).snapshot(sessionId, { forModel });
    return text(obs);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_execute', desc(4), {
  sessionId: z.string(),
  steps: z.array(z.record(z.unknown())).describe('FlowStep[]；导航/写操作需 expect 后置条件'),
  values: z.record(z.unknown()).optional().describe('值字典；敏感值用 {"secretRef":"NAME"}（环境 JEV_BROWSER_SECRET_<NAME>）'),
}, async ({ sessionId, steps, values }) => {
  try {
    const input = { sessionId, steps, values: (values ?? {}) as Record<string, import('@ai-redfish/jev-browser-core').ValueInput> };
    const queued = api
      ? (await api.execute(input)) as unknown as TaskEnvelope
      : await (await rt()).execute(sessionId, input as never);
    const env = api ? await pollUntilSettled(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_run', desc(5), {
  sessionId: z.string(),
  goal: z.string(),
  successCriteria: z.string().describe('用户可观察的验收条件；防止规划器自证成功'),
  values: z.record(z.unknown()).optional(),
}, async ({ sessionId, goal, successCriteria, values }) => {
  try {
    const input = { sessionId, goal, successCriteria, values: values ?? {} };
    const queued = api
      ? (await api.run(input)) as unknown as TaskEnvelope
      : await (await rt()).run(sessionId, input as never);
    const env = api ? await pollUntilSettled(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_act', desc(7), {
  sessionId: z.string(),
  step: z.record(z.unknown()).describe('单个 ActionStep'),
  values: z.record(z.unknown()).optional(),
}, async ({ sessionId, step, values }) => {
  try {
    const input = { step, values: values ?? {} };
    const queued = api
      ? (await api.act(sessionId, input)) as unknown as TaskEnvelope
      : await (await rt()).act(sessionId, { sessionId, step: step as never, values: (values ?? {}) as Record<string, import('@ai-redfish/jev-browser-core').ValueInput> });
    const env = api ? await pollUntilSettled(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_task_get', desc(8), { taskId: z.string() }, async ({ taskId }) => {
  try {
    const env = api ? (await api.getTask(taskId)).envelope : (await rt()).getTask(taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_task_cancel', desc(9), {
  taskId: z.string(),
  requestId: z.string().describe('幂等请求 ID（重复调用返回原结果）'),
  expectedRevision: z.number().optional(),
}, async ({ taskId, requestId, expectedRevision }) => {
  try {
    const env = api ? (await api.cancelTask(taskId, { requestId, expectedRevision })).envelope : await (await rt()).cancelTask(taskId, { requestId, expectedRevision });
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_task_resume', desc(10), {
  taskId: z.string(),
  requestId: z.string(),
  expectedRevision: z.number().optional(),
  rerunConfirmed: z.boolean().optional().describe('未知结果/歧义/断连恢复暂停后，人工确认允许重跑当前步骤'),
  allowReplan: z.boolean().optional().describe('仅 run 任务：允许规划器对未完成后缀重规划（受 maxReplans 预算）'),
}, async ({ taskId, requestId, expectedRevision, rerunConfirmed, allowReplan }) => {
  try {
    const opts = { requestId, expectedRevision, rerunConfirmed, allowReplan };
    const env = api ? (await api.resumeTask(taskId, opts)).envelope : await (await rt()).resumeTask(taskId, opts);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_task_approve', desc(11), {
  taskId: z.string(),
  grant: z.string().describe('HMAC grant token（独立签发，不注入执行 Agent）'),
}, async ({ taskId, grant }) => {
  try {
    const env = api ? (await api.approveTask(taskId, { grant })).envelope : (await rt()).approveTask(taskId, grant);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_artifact_get', desc(12), { taskId: z.string() }, async ({ taskId }) => {
  try {
    const arts = api ? (await api.listArtifacts(taskId)).artifacts : (await rt()).listArtifacts(taskId);
    return text({ taskId, artifacts: arts });
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_disconnect', desc(13), {
  sessionId: z.string(),
  detachTask: z.boolean().optional().describe('有暂停任务时，显式 detach 才允许断开'),
}, async ({ sessionId, detachTask }) => {
  try {
    const result = api ? await api.disconnect(sessionId, detachTask) : await (await rt()).disconnect(sessionId, { detachTask });
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

async function pollUntilSettled(client: ApiClient, taskId: string): Promise<TaskEnvelope> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const { envelope } = await client.getTask(taskId);
    if (envelope.status === 'paused' || ['done', 'failed', 'expired', 'cancelled'].includes(envelope.status)) return envelope;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('等待任务超时');
}

async function shutdown(signal: string): Promise<void> {
  console.error(`[${SERVER_NAME}] 收到 ${signal}，收尾中…`);
  try {
    if (runtime) await runtime.close({ graceMs: 5000 });
  } catch {
    /* 尽力而为 */
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

server.connect(new StdioServerTransport()).then(() => {
  console.error(`[${SERVER_NAME}] MCP 服务已启动（stdio 传输；${apiMode ? 'API 转发模式' : '嵌入模式'}）`);
});
