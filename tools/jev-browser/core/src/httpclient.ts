import type { TaskEnvelope } from './types.js';
import { err } from './errors.js';

/**
 * 长驻共享模式客户端（DESIGN §9.2）：CLI/MCP 显式配置 --api 时转发标准契约，
 * 避免每条命令重连 Chrome。仅 loopback + token（与 api 适配器一致）。
 */

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const url = new URL(opts.baseUrl);
    if (url.protocol !== 'http:' || !/^127\.0\.0\.1$|^::1$|^localhost$/.test(url.hostname)) {
      throw err('CONFIG_INVALID', 'API 地址只允许本机 loopback（长驻共享模式）');
    }
  }

  private async call<T>(method: string, pathUrl: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, '')}${pathUrl}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.token}`,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw err('INTERNAL', `API 返回非 JSON 响应 (${res.status}): ${text.slice(0, 120)}`, { retryable: res.status >= 500 });
      }
    }
    if (!res.ok) {
      const e = data as { error?: { code?: string; message?: string } };
      throw err((e.error?.code as never) ?? 'INTERNAL', e.error?.message ?? `API ${res.status}`, { retryable: res.status >= 500 });
    }
    return data as T;
  }

  diagnostics(): Promise<Record<string, unknown>> {
    return this.call('GET', '/v1/diagnostics');
  }

  createSession(input: unknown): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/sessions', input);
  }

  pages(sessionId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/pages`);
  }

  selectPage(sessionId: string, pageId: string): Promise<Record<string, unknown>> {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/page`, { pageId });
  }

  execute(input: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/tasks/execute', input, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {});
  }

  run(input: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/tasks/run', input, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {});
  }

  act(sessionId: string, input: unknown): Promise<Record<string, unknown>> {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/act`, input);
  }

  snapshot(sessionId: string, forModel?: boolean): Promise<unknown> {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`, { forModel: forModel ?? false });
  }

  getTask(taskId: string): Promise<{ envelope: TaskEnvelope }> {
    return this.call('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  listArtifacts(taskId: string): Promise<{ artifacts: Array<{ artifactId: string; filename: string; size: number; sha256: string }> }> {
    return this.call('GET', `/v1/tasks/${encodeURIComponent(taskId)}/artifacts`);
  }

  cancelTask(taskId: string, input: unknown): Promise<{ envelope: TaskEnvelope }> {
    return this.call('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, input);
  }

  resumeTask(taskId: string, input: unknown): Promise<{ envelope: TaskEnvelope }> {
    return this.call('POST', `/v1/tasks/${encodeURIComponent(taskId)}/resume`, input);
  }

  approveTask(taskId: string, input: unknown): Promise<{ envelope: TaskEnvelope }> {
    return this.call('POST', `/v1/tasks/${encodeURIComponent(taskId)}/approve`, input);
  }

  async saveArtifact(taskId: string, artifactId: string, destPath: string): Promise<void> {
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, '')}/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) throw err('ARTIFACT_NOT_FOUND', `artifact 下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(destPath, buf);
  }

  disconnect(sessionId: string, detachTask?: boolean): Promise<Record<string, unknown>> {
    return this.call('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}${detachTask ? '?detachTask=true' : ''}`);
  }
}
