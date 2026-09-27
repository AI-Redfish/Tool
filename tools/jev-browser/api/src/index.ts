#!/usr/bin/env node
/**
 * @ai-redfish/jev-browser-api —— HTTP API 适配器（本地长驻宿主）
 *
 * 安全基线（DESIGN §10）：仅 loopback、强制 Bearer token、校验 Host、
 * 不启用 CORS、请求体 1MB 上限。路由契约见 DESIGN §8.3。
 */
import http from 'node:http';
import {
  RateLimiter,
  Runtime,
  SCHEMA_VERSION,
  loadConfig,
  runDoctor,
  type TaskEnvelope,
} from '@ai-redfish/jev-browser-core';
import * as fs from 'node:fs';

interface CliFlags {
  config?: string;
  port?: number;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') flags.config = argv[++i];
    if (argv[i] === '--port') flags.port = Number(argv[++i]);
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const { config } = loadConfig({ file: flags.config });
const token = process.env[config.api.tokenEnv];
// 作为入口直接运行时必须有 token；被测试导入（createApiServer）时不强制
if (!token && require.main === module) {
  console.error(`[jev-browser-api] 缺少 API token（环境变量 ${config.api.tokenEnv}）；拒绝启动`);
  process.exit(2);
}

const PRINCIPAL = 'api-host';
const runtime = require.main === module ? new Runtime(config) : (undefined as unknown as Runtime);
const recovery = runtime?.recoverOnStartup();
if (require.main === module) {
  console.error(`[jev-browser-api] 崩溃恢复: ${recovery?.recovered ?? 0} 个遗留任务转暂停，${recovery?.expired ?? 0} 个过期${recovery?.isolated ? '；存在未知在途动作已隔离' : ''}`);
}

const MAX_BODY = 1024 * 1024;

function send(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('请求体顶层必须是对象');
  return parsed as Record<string, unknown>;
}

/** 规范化 Host：去掉端口与 IPv6 括号。 */
function hostOf(req: http.IncomingMessage): string {
  const raw = (req.headers.host ?? '').split(',')[0]!.trim();
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));
  return raw.split(':')[0]!;
}

/** 创建 API 服务器（测试可注入 runtime；生产入口使用真实 runtime）。 */
export function createApiServer(rt: Runtime, opts: { token: string; rateLimitPerMin?: number; maxConcurrent?: number }): http.Server {
  const accessToken = opts.token;
  // DESIGN §10：限定速率/并发（固定窗口按 token 计；仅限写请求）
  const limiter = new RateLimiter(opts.rateLimitPerMin ?? 120);
  let inFlight = 0;
  const maxConcurrent = opts.maxConcurrent ?? 16;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    // Host/Origin 校验：防 DNS rebinding / 浏览器跨站调用（DESIGN §10）
    const host = hostOf(req);
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
      return fail(res, 403, 'POLICY_BLOCKED', `非法 Host: ${host}`);
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${accessToken}`) {
      return fail(res, 401, 'GRANT_INVALID', '缺少或不匹配的 Bearer token');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const idem = req.headers['idempotency-key'] as string | undefined;
    // 速率限制：仅写请求（POST/DELETE）；GET 诊断/查询不限
    if (req.method !== 'GET' && !limiter.allow('api')) {
      return fail(res, 429, 'POLICY_BLOCKED', '请求过于频繁（速率限制，DESIGN §10）');
    }
    if (inFlight >= maxConcurrent) {
      return fail(res, 429, 'POLICY_BLOCKED', `并发请求超过上限 ${maxConcurrent}（DESIGN §10）`);
    }
    inFlight += 1;
    try {
      return await handle(req, res, url, parts, idem);
    } finally {
      inFlight -= 1;
    }
  });

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    parts: string[],
    idem: string | undefined,
  ): Promise<void> {
    // 长任务期间周期回收过期暂停（幂等，成本极低）
    rt.reapExpired();

    try {
      // GET /v1/diagnostics
      if (req.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const doctor = await runDoctor({});
        return send(res, 200, { doctor, schemaVersion: SCHEMA_VERSION });
      }

      // POST /v1/sessions
      if (req.method === 'POST' && url.pathname === '/v1/sessions') {
        const body = await readJsonBody(req);
        const session = await rt.createSession(PRINCIPAL, body as never);
        return send(res, 201, session);
      }

      // GET /v1/sessions/:id/pages
      if (req.method === 'GET' && parts[1] === 'sessions' && parts[3] === 'pages') {
        return send(res, 200, { pages: await rt.listPages(PRINCIPAL, parts[2]!) });
      }

      // POST /v1/sessions/:id/page | .../act | .../snapshot
      if (req.method === 'POST' && parts[1] === 'sessions' && ['page', 'act', 'snapshot'].includes(parts[3] ?? '')) {
        const body = await readJsonBody(req);
        if (parts[3] === 'page') {
          return send(res, 200, await rt.selectPage(PRINCIPAL, parts[2]!, String(body.pageId)));
        }
        if (parts[3] === 'snapshot') {
          return send(res, 200, await rt.snapshot(PRINCIPAL, parts[2]!, { forModel: body.forModel === true }));
        }
        const queued = await rt.act(PRINCIPAL, parts[2]!, { sessionId: parts[2]!, step: body.step as never, values: (body.values ?? {}) as never });
        return send(res, 202, queued);
      }

      // POST /v1/tasks/execute | run
      if (req.method === 'POST' && parts[1] === 'tasks' && (parts[2] === 'execute' || parts[2] === 'run')) {
        const body = await readJsonBody(req);
        const queued = parts[2] === 'execute'
          ? await rt.execute(PRINCIPAL, String(body.sessionId), body as never, { idempotencyKey: idem })
          : await rt.run(PRINCIPAL, String(body.sessionId), body as never, { idempotencyKey: idem });
        return send(res, 202, queued);
      }

      // GET /v1/tasks/:id
      if (req.method === 'GET' && parts[1] === 'tasks' && parts.length === 3) {
        return send(res, 200, { envelope: rt.getTask(PRINCIPAL, parts[2]!) });
      }

      // GET /v1/tasks/:id/artifacts（列表）
      if (req.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts' && parts.length === 4) {
        return send(res, 200, { artifacts: rt.listArtifacts(PRINCIPAL, parts[2]!) });
      }

      // GET /v1/tasks/:id/artifacts/:artifactId（下载；大小上限防内存耗尽）
      if (req.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts' && parts.length === 5) {
        const { path: filePath, filename } = rt.artifactPath(PRINCIPAL, parts[2]!, parts[4]!);
        const stat = fs.statSync(filePath);
        if (stat.size > 200 * 1024 * 1024) {
          return fail(res, 413, 'POLICY_BLOCKED', `artifact 超过 200MB 下载上限: ${stat.size}B`);
        }
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        });
        res.end(data);
        return;
      }

      // POST /v1/tasks/:id/cancel|resume|approve
      if (req.method === 'POST' && parts[1] === 'tasks' && parts.length === 4 && ['cancel', 'resume', 'approve'].includes(parts[3]!)) {
        const body = await readJsonBody(req);
        if (parts[3] === 'cancel') return send(res, 200, { envelope: await rt.cancelTask(PRINCIPAL, parts[2]!, body as never) });
        if (parts[3] === 'resume') return send(res, 200, { envelope: await rt.resumeTask(PRINCIPAL, parts[2]!, body as never) });
        return send(res, 200, { envelope: rt.approveTask(PRINCIPAL, parts[2]!, String(body.grant)) });
      }

      // DELETE /v1/sessions/:id
      if (req.method === 'DELETE' && parts[1] === 'sessions' && parts.length === 3) {
        const detachTask = url.searchParams.get('detachTask') === 'true';
        return send(res, 200, await rt.disconnect(PRINCIPAL, parts[2]!, { detachTask }));
      }

      return fail(res, 404, 'NOT_FOUND', `未知路由: ${req.method} ${url.pathname}`);
    } catch (e) {
      const errObj = e as { code?: string; message?: string };
      if (errObj.code === undefined && /JSON|请求体/.test(errObj.message ?? '')) {
        return fail(res, 400, 'INVALID_INPUT', errObj.message ?? '请求体非法');
      }
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        IDEMPOTENCY_CONFLICT: 409,
        REVISION_CONFLICT: 409,
        SESSION_BUSY: 409,
        BROWSER_BUSY: 409,
        TASK_NOT_RESUMABLE: 409,
        CONFIG_INVALID: 400,
        INVALID_INPUT: 400,
        GRANT_INVALID: 403,
        NEEDS_CONFIRMATION: 409,
        ORIGIN_NOT_ALLOWED: 403,
        POLICY_BLOCKED: 403,
        SESSION_NOT_READY: 409,
        PAGE_NOT_RESOLVED: 409,
      };
      return fail(res, statusMap[errObj.code ?? ''] ?? 500, errObj.code ?? 'INTERNAL', errObj.message ?? String(e));
    }
  }
}

export { runtime as apiRuntime };

if (require.main === module) {
  const server = createApiServer(runtime, {
    token: token!,
    rateLimitPerMin: config.api.rateLimitPerMin,
    maxConcurrent: config.api.maxConcurrentRequests,
  });
  const port = flags.port ?? config.api.port;
  server.listen(port, config.api.host, () => {
    console.error(`[jev-browser-api] 已启动 http://${config.api.host}:${port}（loopback + token；数据目录 ${config.runtime.dataDir}）`);
  });

  async function shutdown(signal: string): Promise<void> {
    console.error(`[jev-browser-api] 收到 ${signal}，收尾中…`);
    server.close();
    await runtime.close({ graceMs: 5000 }).catch(() => undefined);
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
