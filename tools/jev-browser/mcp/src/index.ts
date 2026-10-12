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

import { executeWithPostProcessing, waitForApiTask, type PostProcessingOptions } from './performance.js';

const fastMode = /^(1|true)$/i.test(process.env.JEV_BROWSER_MCP_FAST_MODE ?? '');
const observationSchema = z.object({
  forModel: z.boolean().optional().describe('只回紧凑文本；仍须 origin ∈ modelOrigins'),
  viewportOnly: z.boolean().optional(),
  maxElements: z.number().int().min(1).max(2000).optional(),
  filter: z.string().optional(),
  roles: z.array(z.string()).optional(),
}).strict();
const postProcessingSchema = {
  includeObservation: z.boolean().optional().describe(`默认 ${!fastMode}：附 afterObservation；确定性批处理不需要看页面时传 false`),
  followNewTab: z.boolean().optional().describe(`默认 ${!fastMode}：探测并跟随新页；false 不轮询但仍查一次，完全不查用 detectNewTabs:false`),
  detectNewTabs: z.boolean().optional().describe(`默认 ${!fastMode}：false 跳过前后标签页查询和跟随，适合明确在原页执行；快模式中 followNewTab:true 可重新开启`),
  observationOptions: observationSchema.optional().describe('后置观察筛选；默认视口内、150 个元素。只在 includeObservation 生效时采集'),
};

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

// 外呼代理可见性：Node 默认**不读 Windows 系统代理**（只认环境变量），这是「Jev 报地区限制
// / 451」的头号真因——浏览器能通的服务，本进程直连就失败。启动器会把系统代理注入进来，
// 这里打一行日志，便于在 MCP 日志里确认它到底有没有生效（不含凭据，只有端点）。
if (process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY) {
  console.error(
    `[jev-browser-mcp] 外呼代理: HTTPS_PROXY=${process.env.HTTPS_PROXY ?? '(未设置)'} ` +
      `NODE_USE_ENV_PROXY=${process.env.NODE_USE_ENV_PROXY ?? '(未设置)'} NO_PROXY=${process.env.NO_PROXY ?? '(未设置)'}`,
  );
}

const originSchema = z.array(z.string()).describe('http/https origin 列表，如 ["https://example.com"]');

/** 工具描述统一附加风险标签（DESIGN §3：TOOLS 携带风险标签）。 */
const desc = (i: number) => `${TOOLS[i].description}【风险: ${TOOLS[i].risk}】`;

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function text(data: unknown) {
  // 紧凑 JSON：缩进对模型毫无价值，却让同一份数据膨胀约 1.6 倍（实测快照 21,450 → 13,122 字符）
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}
function textErr(e: unknown) {
  const errObj = e as { code?: string; message?: string };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: errObj.code ?? 'INTERNAL', message: errObj.message ?? String(e) } }) }],
    isError: true,
  };
}

/** Shared execute/act completion path; reuse Runtime and existing authorization gates. */
async function executeAndObserve(
  sessionId: string,
  steps: unknown,
  execute: () => Promise<TaskEnvelope>,
  opts: PostProcessingOptions,
): Promise<Record<string, unknown>> {
  return executeWithPostProcessing(steps, execute, {
    pages: async () => {
      if (api) {
        const result = await api.pages(sessionId) as { pages?: Array<{ pageId: string; url?: string; title?: string }> };
        return result.pages ?? [];
      }
      return (await rt()).listPages(sessionId);
    },
    selectPage: async (pageId) => api ? api.selectPage(sessionId, pageId) : (await rt()).selectPage(sessionId, pageId),
    snapshot: async (opts) => api ? api.snapshot(sessionId, opts) : (await rt()).snapshot(sessionId, opts),
  }, opts, fastMode);
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

server.tool('browser_snapshot', desc(6), {
  sessionId: z.string(),
  forModel: z.boolean().optional().describe('true = 打算发给云模型：只回 rendered 紧凑文本行（需 origin ∈ modelOrigins）'),
  viewportOnly: z.boolean().optional().describe('默认 true 只采集视口内元素（页脚/长列表噪声占大多数）；要整页元素请传 false'),
  maxElements: z.number().int().optional().describe('元素上限，默认 200（硬上限 2000）'),
  filter: z.string().optional().describe('只保留 name 含该子串的元素（大小写不敏感）——「我要找那个东西」时用它，比拉整页小一个量级'),
  roles: z.array(z.string()).optional().describe('只保留这些 role 的元素，如 ["button","textbox"]'),
}, async ({ sessionId, forModel, viewportOnly, maxElements, filter, roles }) => {
  try {
    const opts = {
      forModel,
      viewportOnly: viewportOnly !== false,
      maxElements: maxElements ?? 200,
      filter,
      roles,
    };
    const obs = api ? await api.snapshot(sessionId, opts) : await (await rt()).snapshot(sessionId, opts);
    return text(obs);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_execute', desc(4), {
  sessionId: z.string(),
  steps: z.array(z.union([z.record(z.unknown()), z.string()])).describe(
    '已知步骤应一次批量执行，不要每步 snapshot/act 往返；纯确定性步骤不调用模型。' +
    '每项为 FlowStep 对象或简写：navigate:<url> / click:<loc> / fill:<loc>=<值> / select:<loc>=<值> / ' +
    'press:<键> / scroll:<px> / wait:<ms> / screenshot / evaluate:<js>。' +
    '定位器：role/<role>[/<name>] | label/<name> | testid/<id> | text/<文本> | css/<选择器>；末尾 ! 精确匹配。' +
    '导航/写操作必须追加 => 后置条件，多项用 ; 分隔：url_contains / text_present / visible / hidden / not_visible / ' +
    'count_gte / value_equals / value_contains / var_equals / download_completed。id 自动补；$name 引用 values。' +
    '例：fill:css/#kw=$kw => value_equals:css/#kw=redfish。只知道局部目标时用 goal:<目标>（调用 Jev，需 modelOrigins）。',
  ),
  values: z.record(z.unknown()).optional().describe('值字典；敏感值用 {"secretRef":"NAME"}（环境 JEV_BROWSER_SECRET_<NAME>）'),
  ...postProcessingSchema,
}, async ({ sessionId, steps, values, ...opts }) => {
  try {
    const input = { sessionId, steps, values: (values ?? {}) as Record<string, import('@ai-redfish/jev-browser-core').ValueInput> };
    const out = await executeAndObserve(sessionId, steps, async () => {
      const queued = api
        ? (await api.execute(input)) as unknown as TaskEnvelope
        : await (await rt()).execute(sessionId, input as never);
      return api ? waitForApiTask((id) => api.getTask(id), queued) : (await rt()).waitEnvelope(queued.taskId);
    }, opts);
    return text(out);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_run', desc(5), {
  sessionId: z.string(),
  goal: z.string().describe('自然语言目标。注意：多数场景用 browser_execute 的 goal 步骤更快——run 会先让云模型盲规划整条链路（多一次秒级模型调用），只有「完全不知道从哪下手」时才值得'),
  successCriteria: z.string().describe('用户可观察的验收条件；防止规划器自证成功'),
  values: z.record(z.unknown()).optional(),
}, async ({ sessionId, goal, successCriteria, values }) => {
  try {
    const input = { sessionId, goal, successCriteria, values: values ?? {} };
    const queued = api
      ? (await api.run(input)) as unknown as TaskEnvelope
      : await (await rt()).run(sessionId, input as never);
    const env = api ? await waitForApiTask((id) => api.getTask(id), queued) : await (await rt()).waitEnvelope(queued.taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_act', desc(7), {
  sessionId: z.string(),
  step: z.union([z.record(z.unknown()), z.string()]).describe('单个 ActionStep 对象，或一行简写字符串（语法同 browser_execute.steps）'),
  values: z.record(z.unknown()).optional(),
  ...postProcessingSchema,
}, async ({ sessionId, step, values, ...opts }) => {
  try {
    const input = { step, values: values ?? {} };
    const out = await executeAndObserve(sessionId, [step], async () => {
      const queued = api
        ? (await api.act(sessionId, input)) as unknown as TaskEnvelope
        : await (await rt()).act(sessionId, { sessionId, step: step as never, values: (values ?? {}) as Record<string, import('@ai-redfish/jev-browser-core').ValueInput> });
      return api ? waitForApiTask((id) => api.getTask(id), queued) : (await rt()).waitEnvelope(queued.taskId);
    }, opts);
    return text(out);
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

server.tool('browser_judge', desc(14), {
  sessionId: z.string(),
  question: z.string().describe('要向 Jev 提的是/否问题，如「页面上是否出现了订单号？」'),
}, async ({ sessionId, question }) => {
  try {
    const result = api ? await api.judgePage(sessionId, question) : await (await rt()).judgePage(sessionId, question);
    return text(result);
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
  console.error(`[${SERVER_NAME}] MCP 服务已启动（stdio 传输；${apiMode ? 'API 转发模式' : '嵌入模式'}；${fastMode ? '快速模式：按需观察/探测新页' : '兼容模式：自动观察/跟页'}）`);
});
