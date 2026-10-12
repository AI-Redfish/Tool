const assert = require('node:assert/strict');
const { test } = require('node:test');
const { executeWithPostProcessing, resolvePostProcessing, stepsMayOpenTab, waitForApiTask } = require('../dist/performance.js');

const envelope = (status = 'done') => ({
  schemaVersion: 1, taskId: 't1', sessionId: 's1', mode: 'execute', revision: 1,
  status, stepResults: [], metrics: { queuedMs: 0, runningMs: 0, actions: 0, jevRequests: 0, plannerRequests: 0 }, artifacts: [],
});
function fixture() {
  const calls = [];
  let pages = [{ pageId: 'p0' }];
  const ports = {
    pages: async () => { calls.push('pages'); return [...pages]; },
    selectPage: async (id) => { calls.push(`select:${id}`); },
    snapshot: async (opts) => { calls.push(['snapshot', opts]); return { title: 'result' }; },
  };
  const execute = async () => { calls.push('execute'); return envelope(); };
  return { ports, calls, execute, open: () => pages.push({ pageId: 'p1' }) };
}

test('legacy defaults: snapshot follows discovery, metrics do not mutate envelope', async () => {
  const f = fixture(); const env = envelope();
  const result = await executeWithPostProcessing(['scroll:10'], async () => { f.calls.push('execute'); return env; }, f.ports);
  assert.deepEqual(f.calls, ['pages', 'execute', 'pages', ['snapshot', { viewportOnly: true, maxElements: 150 }]]);
  assert.equal(result.status, 'done'); assert.deepEqual(result.afterObservation, { title: 'result' });
  assert.equal(env.mcpMetrics, undefined);
  for (const value of Object.values(result.mcpMetrics)) assert.ok(Number.isFinite(value) && value >= 0);
});

test('fast mode: zero page queries, selections and snapshots even for clicks', async () => {
  const f = fixture();
  const result = await executeWithPostProcessing(['click:css/#submit'], f.execute, f.ports, {}, true);
  assert.deepEqual(f.calls, ['execute']);
  assert.equal(result.afterObservation, undefined); assert.equal(result.openedPages, undefined);
  assert.equal(result.mcpMetrics.pageTrackingMs, 0); assert.equal(result.mcpMetrics.observationMs, 0);
});

test('per-call opt-outs provide the fast path without changing server mode', async () => {
  const f = fixture();
  await executeWithPostProcessing(['click:css/#submit'], f.execute, f.ports, { detectNewTabs: false, includeObservation: false });
  assert.deepEqual(f.calls, ['execute']);
});

test('followNewTab:false preserves discovery but performs no follow/wait', async () => {
  const f = fixture();
  const result = await executeWithPostProcessing(['click:css/#submit'], async () => { f.open(); return f.execute(); }, f.ports,
    { followNewTab: false, includeObservation: false });
  assert.deepEqual(f.calls, ['pages', 'execute', 'pages']);
  assert.deepEqual(result.openedPages, [{ pageId: 'p1' }]); assert.equal(result.followedPageId, undefined);
});

test('fast mode explicitly opts back into following and filtered observation', async () => {
  const f = fixture(); const opts = { filter: '订单', roles: ['button'], maxElements: 20, forModel: true };
  const result = await executeWithPostProcessing(['click:css/#submit'], async () => { f.open(); return f.execute(); }, f.ports,
    { followNewTab: true, includeObservation: true, observationOptions: opts }, true);
  assert.deepEqual(f.calls, ['pages', 'execute', 'pages', 'select:p1', ['snapshot', { viewportOnly: true, ...opts }]]);
  assert.equal(result.followedPageId, 'p1');
});

test('explicit detection disable takes precedence over following', async () => {
  assert.equal(resolvePostProcessing({ detectNewTabs: false, followNewTab: true }, true).detectNewTabs, false);
  const f = fixture();
  await executeWithPostProcessing([], f.execute, f.ports, { detectNewTabs: false, followNewTab: true }, true);
  assert.deepEqual(f.calls, ['execute']);
});

test('baseline discovery failure cannot misidentify existing pages as new', async () => {
  const f = fixture(); f.ports.pages = async () => { throw new Error('discovery failed'); };
  const result = await executeWithPostProcessing([], f.execute, f.ports);
  assert.equal(result.status, 'done'); assert.equal(result.openedPages, undefined);
  assert.equal(result.afterObservation.title, 'result');
});

test('post-discovery and snapshot failure cannot erase task failure or trigger replay', async () => {
  const f = fixture(); let lists = 0; let executions = 0;
  f.ports.pages = async () => { if (++lists === 1) return [{ pageId: 'p0' }]; throw new Error('gone'); };
  f.ports.snapshot = async () => { throw new Error('forModel origin denied'); };
  const env = { ...envelope('failed'), error: { code: 'ACTION_FAILED', message: 'expect failed', retryable: false } };
  const result = await executeWithPostProcessing([], async () => { executions++; return env; }, f.ports);
  assert.equal(executions, 1); assert.deepEqual(result.error, env.error); assert.equal(result.status, 'failed');
});

test('failed selection reports opened pages without claiming successful following', async () => {
  const f = fixture(); f.ports.selectPage = async () => { throw new Error('closed'); };
  const result = await executeWithPostProcessing([], async () => { f.open(); return f.execute(); }, f.ports);
  assert.ok(result.openedPages); assert.equal(result.followedPageId, undefined); assert.ok(result.afterObservation);
});

test('task submission failure propagates and never observes or replays', async () => {
  const f = fixture();
  await assert.rejects(executeWithPostProcessing([], async () => { throw new Error('origin denied'); }, f.ports), /origin denied/);
  assert.deepEqual(f.calls, ['pages']);
});

test('tab detection recognizes nested clicks, goal, press and evaluate', () => {
  for (const steps of [
    [' click:css/a'], ['goal:open detail'], ['press:Enter'], ['evaluate:window.open()'],
    [{ kind: 'branch', then: [{ kind: 'forEach', body: [{ kind: 'action', action: 'click' }] }] }],
    [{ kind: 'goal', goal: 'open detail' }], [{ kind: 'action', action: 'press' }],
  ]) assert.equal(stepsMayOpenTab(steps), true);
  assert.equal(stepsMayOpenTab(['fill:css/#q=x', 'scroll:20', { kind: 'assert' }]), false);
  assert.equal(stepsMayOpenTab(undefined), false);
});

test('delayed new tab from a nested action is followed before observation', async () => {
  const f = fixture();
  const result = await executeWithPostProcessing([{ kind: 'branch', then: [{ kind: 'action', action: 'click' }] }],
    async () => { setTimeout(f.open, 40); return f.execute(); }, f.ports);
  assert.equal(result.followedPageId, 'p1');
  assert.deepEqual(f.calls.slice(-2), ['select:p1', ['snapshot', { viewportOnly: true, maxElements: 150 }]]);
});

test('paused task keeps its reason, approval and failed-step evidence in the fast path', async () => {
  const f = fixture();
  const env = { ...envelope('paused'), pauseReason: 'needs_confirmation',
    pendingApproval: { actionRevision: 1, action: 'click', reason: 'confirm' },
    stepResults: [{ id: 's1', kind: 'action', status: 'paused', evidence: { url: 'https://example.com/' } }] };
  const result = await executeWithPostProcessing([], async () => env, f.ports, {}, true);
  assert.equal(result.pauseReason, env.pauseReason);
  assert.deepEqual(result.pendingApproval, env.pendingApproval);
  assert.deepEqual(result.stepResults, env.stepResults);
  assert.deepEqual(f.calls, []);
});

test('API polling: terminal initial responses avoid all queries', async () => {
  for (const status of ['done', 'paused', 'failed', 'expired', 'cancelled']) {
    await waitForApiTask(async () => { assert.fail('unnecessary query'); }, envelope(status));
  }
});

test('API polling: short task observed at 100ms rather than old 500ms tick', async () => {
  let now = 0; let queries = 0; const sleeps = [];
  const result = await waitForApiTask(async () => { queries++; return { envelope: envelope(now >= 90 ? 'done' : 'running') }; }, envelope('queued'),
    { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  assert.equal(result.status, 'done'); assert.equal(now, 100); assert.equal(queries, 2); assert.deepEqual(sleeps, [100]);
});

test('API polling: long tasks back off to 500ms and timeout at deadline', async () => {
  let now = 0; const sleeps = [];
  await assert.rejects(waitForApiTask(async () => ({ envelope: envelope('running') }), envelope('queued'),
    { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } }), /等待任务超时/);
  assert.equal(now, 30 * 60_000); assert.deepEqual(sleeps.slice(0, 5), [100, 200, 400, 500, 500]);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 500));
});

test('API polling: transport errors propagate without retrying task submission', async () => {
  await assert.rejects(waitForApiTask(async () => { throw new Error('API disconnected'); }, envelope('running')), /API disconnected/);
});
