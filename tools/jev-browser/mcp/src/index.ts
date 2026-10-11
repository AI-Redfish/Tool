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
  pollNewPages,
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

/**
 * execute/act 落定后自动附一份紧凑观察，省掉「做完再喊一次 snapshot」的第二次往返
 * ——对话式操作里这一步的往返和 token 成本比浏览器动作本身高得多。
 * 观察失败不影响任务结果本身（吞掉异常）。
 */
async function attachObservation(
  sessionId: string,
  payload: unknown,
  opts: { viewportOnly: boolean; maxElements: number },
): Promise<unknown> {
  try {
    const obs = api
      ? await api.snapshot(sessionId, { viewportOnly: opts.viewportOnly, maxElements: opts.maxElements })
      : await (await rt()).snapshot(sessionId, { viewportOnly: opts.viewportOnly, maxElements: opts.maxElements });
    return { ...(payload as Record<string, unknown>), afterObservation: obs };
  } catch {
    return payload;
  }
}

/** execute/act 的观察选项：默认只回视口内的元素，并把上限压到 150。 */
const OBS_OPTS = { viewportOnly: true, maxElements: 150 };

/** 当前会话可见的标签页；失败返回空数组（标签页信息不该让整个任务结果失败）。 */
async function pagesOf(sessionId: string): Promise<Array<{ pageId: string; url?: string; title?: string }>> {
  try {
    if (api) {
      const r = (await api.pages(sessionId)) as { pages?: Array<{ pageId: string; url?: string; title?: string }> };
      return r.pages ?? [];
    }
    return await (await rt()).listPages(sessionId);
  } catch {
    return [];
  }
}

/**
 * 新标签页的出现**晚于任务落定**：浏览器处理 target=_blank 是异步的。
 * 实测（本地 fixture + Playwright 直接量）：点击 resolve 之后还要 **276~440ms** 才能在
 * context.pages() 里看到新页——所以「任务一结束就查一次」必然漏报（连续两次点击确实都开了
 * 新页，却一次都没报出来，就是这么来的）。
 *
 * 窗口取 700ms = 实测上限的 1.6 倍。这份等待只在**步骤里含 click** 时才付。
 * 明确不关心新页的场景（连续开多个结果页）传 followNewTab:false 可彻底免等（只查一次）。
 */
const NEW_TAB_WAIT_MS = 700;

/** 步骤里是否可能出现新标签页（简写以 click: 开头，或对象形式的 action==='click'）。 */
function stepsMayOpenTab(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((s) => {
    if (typeof s === 'string') return /^\s*click\s*:/.test(s);
    if (s && typeof s === 'object') return (s as { action?: string }).action === 'click';
    return false;
  });
}

/**
 * 识别「任务期间新开的标签页」。搜索/列表页的结果链接普遍是 target=_blank，点一下就多一个页；
 * 不在这里识别，调用方就得再花 pages + select-page 两次往返才能继续，而这两次是纯开销。
 * followNewTab 顺手把「切过去」也做掉，并在结果里明示 followedPageId——不是静默换页。
 */
async function trackNewPages(
  sessionId: string,
  before: Array<{ pageId: string }>,
  followNewTab: boolean,
  mayOpenTab: boolean,
): Promise<Record<string, unknown>> {
  // followNewTab=false 表示调用方自己管标签页，这时连探测都不必等（只查一次）
  const opened = await pollNewPages(before, () => pagesOf(sessionId), {
    waitMs: followNewTab && mayOpenTab ? NEW_TAB_WAIT_MS : 0,
  });
  if (opened.length === 0) return {};
  const out: Record<string, unknown> = { openedPages: opened };
  if (followNewTab) {
    const newest = opened[opened.length - 1]!;
    try {
      if (api) await api.selectPage(sessionId, newest.pageId);
      else await (await rt()).selectPage(sessionId, newest.pageId);
      out.followedPageId = newest.pageId;
    } catch {
      /* 跟随失败不改任务结果；调用方仍可自行 select-page */
    }
  }
  return out;
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
    '步骤数组，每项是 FlowStep 对象或一行简写字符串。' +
    '【选路径，按速度排序】① 知道点哪 → 直接写确定性步骤，如 "click:css/#submit => url_contains:/done"（0 次模型调用，约 100ms）；' +
    '② 只知道要达成什么、不知道点哪 → 写 "goal:<自然语言目标>"，由 Jev 在服务端自己观察并选动作——全程仍只占 1 次调用，' +
    '中间观察不进入你的上下文（比你自己 snapshot→读→click 快一个量级；需该页 origin ∈ modelOrigins）；' +
    '③ 只是要验证某个条件 → 用 browser_judge 问一句，不要拉整屏元素。' +
    '【简写语法】"navigate:<url>" / "click:<loc>" / "fill:<loc>=<值>" / "select:<loc>=<值>" / "press:<键>" / "scroll:<px>" / "wait:<ms>" / "screenshot" / "evaluate:<js>"；' +
    '定位器 role/<role>[/<name>] | label/<name> | testid/<id> | text/<文本> | css/<选择器>，末尾加 "!" 表示精确匹配；' +
    '后置条件追加 " => "（多项用 ";" 分隔）：url_contains / text_present / visible / hidden / not_visible / count_gte / value_equals / var_equals / download_completed。' +
    '【约束】id 可省略（自动补）；导航/写操作必须有 expect。' +
    '例："click:role/button/搜索 => url_contains:/search"、"fill:css/#pw=$password => value_equals:css/#pw=<原值>"、"goal:打开搜索结果里的第二个视频 => url_contains:/video/"',
  ),
  values: z.record(z.unknown()).optional().describe('值字典；敏感值用 {"secretRef":"NAME"}（环境 JEV_BROWSER_SECRET_<NAME>）'),
  includeObservation: z.boolean().optional().describe('默认 true：任务落定后自动附 afterObservation（视口内紧凑观察），省掉一次 snapshot 往返'),
  followNewTab: z.boolean().optional().describe('默认 true：任务期间新开的标签页自动切过去（结果里以 openedPages/followedPageId 明示，非静默）；传 false 则免去含 click 任务最多 0.7s 的新页探测等待'),
}, async ({ sessionId, steps, values, includeObservation, followNewTab }) => {
  try {
    const input = { sessionId, steps, values: (values ?? {}) as Record<string, import('@ai-redfish/jev-browser-core').ValueInput> };
    const before = await pagesOf(sessionId);
    const queued = api
      ? (await api.execute(input)) as unknown as TaskEnvelope
      : await (await rt()).execute(sessionId, input as never);
    const env = api ? await pollUntilSettled(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    const payload = { ...(env as unknown as Record<string, unknown>), ...(await trackNewPages(sessionId, before, followNewTab !== false, stepsMayOpenTab(steps))) };
    const out = includeObservation === false ? payload : await attachObservation(sessionId, payload, OBS_OPTS);
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
    const env = api ? await pollUntilSettled(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_act', desc(7), {
  sessionId: z.string(),
  step: z.union([z.record(z.unknown()), z.string()]).describe('单个 ActionStep 对象，或一行简写字符串（语法同 browser_execute.steps）'),
  values: z.record(z.unknown()).optional(),
  includeObservation: z.boolean().optional().describe('默认 true：落定后自动附 afterObservation'),
  followNewTab: z.boolean().optional().describe('默认 true：新开的标签页自动切过去（结果里明示 openedPages/followedPageId）；传 false 则免去最多 0.7s 的新页探测等待'),
}, async ({ sessionId, step, values, includeObservation, followNewTab }) => {
  try {
    const input = { step, values: values ?? {} };
    const before = await pagesOf(sessionId);
    const queued = api
      ? (await api.act(sessionId, input)) as unknown as TaskEnvelope
      : await (await rt()).act(sessionId, { sessionId, step: step as never, values: (values ?? {}) as Record<string, import('@ai-redfish/jev-browser-core').ValueInput> });
    const env = api ? await pollUntilSettled(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    const payload = { ...(env as unknown as Record<string, unknown>), ...(await trackNewPages(sessionId, before, followNewTab !== false, stepsMayOpenTab([step]))) };
    const out = includeObservation === false ? payload : await attachObservation(sessionId, payload, OBS_OPTS);
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
