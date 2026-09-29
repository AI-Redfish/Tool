import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performAction, FsArtifactSink } from '../src/executor.js';
import { ActionOutcomeUnknownError } from '../src/errors.js';
import { FakePage } from './fakes.js';
import type { ActionStep } from '../src/types.js';

/** 可读取记录的执行上下文工厂。 */
function makeRecordingCtx(values: Record<string, unknown> = {}) {
  const entries: Array<{ rev: number; state: string }> = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-exec-'));
  const ctx: Parameters<typeof performAction>[2] = {
    vars: {} as Record<string, unknown>,
    values,
    artifacts: new FsArtifactSink(dir),
    ledger: {
      prepared: (_s, rev) => entries.push({ rev, state: 'prepared' }),
      inFlight: (_s, rev) => entries.push({ rev, state: 'in_flight' }),
      finished: (_s, rev, state) => entries.push({ rev, state }),
    },
    actionRevision: 7,
    actionTimeoutMs: 2000,
    cancelFlag: { cancelled: false },
  };
  return { ctx, entries, dir };
}

test('账本三态收口：成功 verified / 断言失败 failed / 超时 unknown', async () => {
  // 成功
  {
    const page = new FakePage({ url: 'https://example.com/', bodyText: 'Example' });
    const { ctx, entries } = makeRecordingCtx();
    await performAction(page, {
      id: 's1', kind: 'action', action: 'navigate', value: 'https://example.com/x',
      expect: [{ kind: 'url_contains', value: 'example.com' }],
    }, ctx);
    assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'verified']);
  }
  // 后置条件失败 → failed
  {
    const page = new FakePage({ url: 'https://example.com/', bodyText: 'Example' });
    const { ctx, entries } = makeRecordingCtx();
    await assert.rejects(
      performAction(page, {
        id: 's2', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: 'x' },
        expect: [{ kind: 'url_contains', value: 'other.com' }],
      }, ctx),
      (e: unknown) => (e as { code?: string }).code === 'ACTION_FAILED',
    );
    assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'failed']);
  }
  // 超时且无法证实 → unknown + ActionOutcomeUnknownError
  {
    const page = new FakePage({ url: 'https://example.com/', bodyText: 'Example', clickError: new Error('TimeoutError: 30000ms exceeded') });
    const { ctx, entries } = makeRecordingCtx();
    await assert.rejects(
      performAction(page, {
        id: 's3', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: 'x' },
        expect: [{ kind: 'url_contains', value: 'never' }],
      }, ctx),
      (e: unknown) => e instanceof ActionOutcomeUnknownError,
    );
    assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'unknown']);
  }
});

test('下载动作：saveAs 到受管 artifact 区，临时文件清理，变量落盘', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'Example', downloadAfterClick: { filename: 'report.csv', content: 'id,name\n1,a' } });
  const { ctx, entries, dir } = makeRecordingCtx();
  const step: ActionStep = {
    id: 'd1', kind: 'action', action: 'click',
    target: { by: 'role', role: 'link', name: 'download' },
    expect: [{ kind: 'download_completed', variable: 'file' }],
  };
  const out = await performAction(page, step, ctx);
  assert.ok(out.artifactId);
  assert.equal(ctx.vars['file'], out.artifactId);
  const saved = readdirSync(dir).filter((f) => !f.startsWith('.tmp-'));
  assert.equal(saved.length, 1);
  assert.ok(saved[0]!.includes('report.csv'));
  assert.ok(!existsSync(path.join(dir, '.tmp-0')));
  assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'verified']);
  assert.equal(readFileSync(path.join(dir, saved[0]!), 'utf8'), 'id,name\n1,a');
});

test('navigate 缺 value：INVALID_INPUT，不进入 prepared', async () => {
  const page = new FakePage({});
  const { ctx, entries } = makeRecordingCtx();
  await assert.rejects(
    performAction(page, { id: 'n1', kind: 'action', action: 'navigate', expect: [{ kind: 'url_contains', value: 'x' }] }, ctx),
    /navigate/,
  );
  assert.deepEqual(entries, []);
});

test('取消旗标：动作不派发、无账本写入', async () => {
  const page = new FakePage({});
  const { ctx, entries } = makeRecordingCtx();
  ctx.cancelFlag!.cancelled = true;
  await assert.rejects(
    performAction(page, {
      id: 'c1', kind: 'action', action: 'click', target: { by: 'css', selector: '#a' },
      expect: [{ kind: 'visible', target: { by: 'css', selector: '#a' } }],
    }, ctx),
    (e: unknown) => (e as { code?: string }).code === 'POLICY_BLOCKED',
  );
  assert.deepEqual(entries, []);
});

test('valuesRef 引用 secretRef 未解析值时拒绝', async () => {
  const page = new FakePage({});
  const { ctx, entries } = makeRecordingCtx({ token: { secretRef: 'PW' } });
  await assert.rejects(
    performAction(page, {
      id: 'v1', kind: 'action', action: 'fill', target: { by: 'css', selector: '#pw' }, valuesRef: 'token',
      expect: [{ kind: 'visible', target: { by: 'css', selector: '#pw' } }],
    }, ctx),
    /secretRef/,
  );
  assert.deepEqual(entries, []);
});

// ---- evaluate（已放开限制）：模型脚本直接执行，返回值记入 lastEvaluate ----

test('evaluate：脚本直接执行，返回值记入 lastEvaluate，账本 verified', async () => {
  const page = new FakePage({});
  const { ctx, entries } = makeRecordingCtx();
  await performAction(page, {
    id: 'e1', kind: 'action', action: 'evaluate', script: 'document.readyState', expect: [],
  }, ctx);
  assert.ok(page.calls.includes('evaluate'));
  assert.equal(ctx.vars['lastEvaluate'], 'true');
  assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'verified']);
});

test('evaluate：空白 script 拒绝', async () => {
  const page = new FakePage({});
  const { ctx } = makeRecordingCtx();
  await assert.rejects(
    performAction(page, { id: 'e2', kind: 'action', action: 'evaluate', script: '   ', expect: [] }, ctx),
    /evaluate 需要非空 script/,
  );
  assert.equal(ctx.vars['lastEvaluate'], undefined);
});

// ---- upload（已放开限制）：任意路径可上传；仅保留大小/存在性/绝对路径预检 ----

test('upload：未配置 allowedUploadDirs 也能直接派发（已放开目录白名单）；账本 verified', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-up-'));
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const file = path.join(dir, 'docs', 'report.pdf');
  writeFileSync(file, 'pdf-bytes');

  // 不配置 allowedUploadDirs：任意路径直接上传
  {
    const page = new FakePage({ url: 'https://example.com/upload', bodyText: 'x' });
    const { ctx, entries } = makeRecordingCtx();
    await performAction(page, { id: 'u2', kind: 'action', action: 'upload', target: { by: 'css', selector: 'input' }, filePath: file, expect: [] } as never, ctx);
    assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'verified']);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('upload 安全矩阵（已放开后）：超限/相对路径/缺失文件仍拒绝', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-up2-'));
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', 'a.txt'), 'ok-data');
  writeFileSync(path.join(dir, '.env'), 'PW=1');
  writeFileSync(path.join(dir, 'outside.txt'), 'out');
  const dirs = [path.join(dir, 'docs')];

  type AttemptResult = { ok: boolean; code?: string; entries: Array<{ rev: number; state: string }> };
  const attempt = async (filePath: string, maxBytes?: number): Promise<AttemptResult> => {
    const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
    const { ctx, entries } = makeRecordingCtx();
    ctx.allowedUploadDirs = dirs;
    if (maxBytes !== undefined) ctx.maxUploadBytes = maxBytes;
    try {
      await performAction(page, { id: 'ux', kind: 'action', action: 'upload', target: { by: 'css', selector: 'input' }, filePath, expect: [] } as never, ctx);
      return { ok: true, entries };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code, entries };
    }
  };

  // 已放开：秘密文件（.env）与目录外文件均可上传
  assert.equal((await attempt(path.join(dir, '.env'))).ok, true);
  assert.equal((await attempt(path.join(dir, 'outside.txt'))).ok, true);
  // 大小预检仍然生效
  assert.equal((await attempt(path.join(dir, 'docs', 'a.txt'), 2)).code, 'POLICY_BLOCKED');
  // 相对路径
  assert.equal((await attempt('docs/a.txt')).code, 'INVALID_INPUT');
  // 不存在的文件
  assert.equal((await attempt(path.join(dir, 'docs', 'nope.txt'))).code, 'INVALID_INPUT');
  rmSync(dir, { recursive: true, force: true });
});
