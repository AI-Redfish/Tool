import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Runtime, validateExecuteSteps, resolveValues } from '../src/taskservice.js';
import { loadConfig, defaultConfig } from '../src/config.js';
import { signGrant } from '../src/grants.js';
import { TaskStore } from '../src/store.js';
import { FakeBrowser, FakeConnector, FakeContext, FakeJudge, FakePage } from './fakes.js';
import type { PlannerProvider } from '../src/planner.js';
import type { FlowStep, TaskEnvelope } from '../src/types.js';
import type { JevBrowserConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// 测试环境：临时 dataDir + Fake 浏览器/裁判（无网络、无真实浏览器）
// ---------------------------------------------------------------------------

let dir: string;
let store: TaskStore;

function testConfig(overrides: Partial<JevBrowserConfig> = {}): JevBrowserConfig {
  const cfg = defaultConfig();
  cfg.runtime.dataDir = dir;
  cfg.safety.allowedOrigins = ['https://example.com'];
  cfg.runtime.queueTimeoutMs = 2000;
  return { ...cfg, ...overrides };
}

function makeRuntime(cfg: JevBrowserConfig, pages: FakePage[], judge?: FakeJudge, planner?: PlannerProvider): Runtime {
  store = new TaskStore(path.join(dir, 'tasks.db'));
  const ctx = new FakeContext(pages);
  const browser = new FakeBrowser(ctx);
  return new Runtime(cfg, {
    store,
    connector: new FakeConnector(browser),
    judge: judge ?? new FakeJudge({ decisions: [] }),
    planner,
  });
}

function flow(steps: FlowStep[]): FlowStep[] {
  return JSON.parse(JSON.stringify(steps)) as FlowStep[];
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jev-rt-'));
  delete process.env.JEV_BROWSER_APPROVAL_KEY;
  delete process.env.JEV_BROWSER_SECRET_PW;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// execute 主路径
// ---------------------------------------------------------------------------

test('execute：确定性流程完成，模型调用为 0', async () => {
  const page = new FakePage({ url: 'https://example.com/page', bodyText: 'Example Domain' });
  const judge = new FakeJudge({ decisions: [] });
  const rt = makeRuntime(testConfig(), [page], judge);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  assert.equal(session.status, 'ready');
  const env = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([
      { id: 's1', kind: 'extract', target: { by: 'css', selector: 'h1' }, fields: ['text'], saveAs: 'h' },
      { id: 's2', kind: 'assert', expect: [{ kind: 'text_present', value: 'Example Domain' }] },
    ]),
    values: {},
  });
  const final = await rt.waitEnvelope(env.taskId);
  assert.equal(final.status, 'done');
  assert.equal(final.metrics.actions, 0); // 无写动作
  assert.equal(judge.usage().jevRequests, 0); // 纯确定性：0 模型调用
  await rt.close();
});

test('execute：写操作缺 expect 被拒绝；非授权 origin 被策略拦截', async () => {
  const page = new FakePage({ url: 'https://example.com/' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  await assert.rejects(
    rt.execute(session.sessionId, {
      sessionId: session.sessionId,
      // 故意缺少 expect：由 validateExecuteSteps 在提交时拒绝（类型层用 as 绕过以表达非法输入）
      steps: [{ id: 'w1', kind: 'action', action: 'fill', target: { by: 'css', selector: '#q' }, value: 'x' }] as unknown as FlowStep[],
      values: {},
    }),
    /expect 后置条件/,
  );
  // navigate 到未授权 origin → ORIGIN_NOT_ALLOWED → failed
  const env = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'nav', kind: 'action', action: 'navigate', value: 'https://evil.com/', expect: [{ kind: 'url_contains', value: 'evil' }] }]),
    values: {},
  });
  const final = await rt.waitEnvelope(env.taskId);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'ORIGIN_NOT_ALLOWED');
  await rt.close();
});

test('幂等：同键同体返回原任务；同键不同体冲突', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const input = {
    sessionId: session.sessionId,
    steps: flow([{ id: 'a', kind: 'assert', expect: [] }]),
    values: {},
  };
  const e1 = await rt.execute(session.sessionId, input as never, { idempotencyKey: 'k1' });
  const e2 = await rt.execute(session.sessionId, input as never, { idempotencyKey: 'k1' });
  assert.equal(e1.taskId, e2.taskId);
  await assert.rejects(
    rt.execute(session.sessionId, { ...input, steps: flow([{ id: 'b', kind: 'assert', expect: [] }]) } as never, { idempotencyKey: 'k1' }),
    (e: unknown) => (e as { code?: string }).code === 'IDEMPOTENCY_CONFLICT',
  );
  await rt.close();
});

// ---------------------------------------------------------------------------
// 高风险动作 → 暂停 → grant 审批 → 恢复
// ---------------------------------------------------------------------------

test('高风险目标暂停 needs_confirmation；approve + resume 后完成', async () => {
  process.env.JEV_BROWSER_APPROVAL_KEY = 'secret-key';
  const page = new FakePage({ url: 'https://example.com/cart', bodyText: 'ok' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const steps = flow([
    { id: 'risk', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: '确认支付' }, expect: [{ kind: 'text_present', value: 'ok' }] },
  ]);
  const env = await rt.execute(session.sessionId, { sessionId: session.sessionId, steps: steps as never, values: {} });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pauseReason, 'needs_confirmation');
  assert.ok(paused.pendingApproval);
  assert.equal(paused.pendingApproval!.action, 'click');

  // 无 grant 的 resume 被拒绝
  await assert.rejects(
    rt.resumeTask(paused.taskId, { requestId: 'r1' }),
    (e: unknown) => (e as { code?: string }).code === 'NEEDS_CONFIRMATION',
  );
  // 用执行 Agent 的身份伪造 approved: true 没有任何通道 —— 只能凭 grant
  const { signature } = signGrant(
    { grantId: 'g1', taskId: paused.taskId, actionRevision: paused.pendingApproval!.actionRevision, action: 'click', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    'secret-key',
  );
  const approved = rt.approveTask(paused.taskId, signature);
  assert.equal(approved.status, 'paused'); // approve 只登记，不执行

  const resumed = await rt.resumeTask(paused.taskId, { requestId: 'r2' });
  const final = await rt.waitEnvelope(resumed.taskId);
  assert.equal(final.status, 'done');
  // 取消任务1释放 profile 预约；grant 一次性：新任务（新 actionRevision/新 taskId）不能复用旧 grant
  await rt.cancelTask(paused.taskId, { requestId: 'r3' });
  const env2 = await rt.execute(session.sessionId, { sessionId: session.sessionId, steps: steps as never, values: {} });
  const paused2 = await rt.waitEnvelope(env2.taskId);
  assert.equal(paused2.status, 'paused');
  assert.throws(
    () => rt.approveTask(paused2.taskId, signature),
    (e: unknown) => (e as { code?: string }).code === 'GRANT_INVALID',
  );
  await rt.close();
});

// ---------------------------------------------------------------------------
// 取消 / 会话 / 断开
// ---------------------------------------------------------------------------

test('cancel：queued 立即取消；同 requestId 重放返回原结果', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  // 用受控 Promise 阻塞第一个任务（占住 profile 队列）
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  (page as unknown as { waitForTimeout: () => Promise<void> }).waitForTimeout = () => gate;
  const blocker = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'slow', kind: 'action', action: 'wait', value: 100, expect: [] }]),
    values: {},
  });
  await new Promise((r) => setTimeout(r, 50)); // 让 blocker 进入 running
  const queued = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'a', kind: 'assert', expect: [] }]),
    values: {},
  });
  assert.equal(queued.status, 'queued');
  const cancelled = await rt.cancelTask(queued.taskId, { requestId: 'c1' });
  assert.equal(cancelled.status, 'cancelled');
  const replay = await rt.cancelTask(queued.taskId, { requestId: 'c1' });
  assert.equal(replay.taskId, queued.taskId);
  assert.equal(replay.status, 'cancelled');
  release(); // 放行 blocker，避免悬挂
  await rt.waitEnvelope(blocker.taskId);
  await rt.close();
});

test('disconnect：有活动任务拒绝；暂停任务需显式 detach；断开后 resume 重绑页面', async () => {
  process.env.JEV_BROWSER_APPROVAL_KEY = 'k';
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'ok' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'risk', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: '确认支付' }, expect: [{ kind: 'text_present', value: 'ok' }] }]),
    values: {},
  });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  await assert.rejects(rt.disconnect(session.sessionId), /detachTask/);
  await rt.disconnect(session.sessionId, { detachTask: true });
  const after = store.getSession(session.sessionId);
  assert.equal(after?.status, 'disconnected');
  // 断开后 resume：needs_confirmation 需 grant；重绑页面后继续
  await assert.rejects(
    rt.resumeTask(paused.taskId, { requestId: 'r8' }),
    (e: unknown) => (e as { code?: string }).code === 'NEEDS_CONFIRMATION',
  );
  const { signature } = signGrant(
    { grantId: 'g9', taskId: paused.taskId, actionRevision: paused.pendingApproval!.actionRevision, action: 'click', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    'k',
  );
  rt.approveTask(paused.taskId, signature);
  const resumed = await rt.resumeTask(paused.taskId, { requestId: 'r9' });
  const final = await rt.waitEnvelope(resumed.taskId);
  assert.equal(final.status, 'done');
  await rt.close();
});

// ---------------------------------------------------------------------------
// run 模式 / 隔离 / 跨主体
// ---------------------------------------------------------------------------

test('run：planner 未配置快速失败；successCriteria 缺失拒绝', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]); // planner = null
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: ['https://example.com'],
  });
  await assert.rejects(
    rt.run(session.sessionId, { sessionId: session.sessionId, goal: 'g', successCriteria: 's', values: {} }),
    (e: unknown) => (e as { code?: string }).code === 'PLANNER_NOT_CONFIGURED',
  );
  await assert.rejects(
    rt.run(session.sessionId, { sessionId: session.sessionId, goal: 'g', successCriteria: ' ', values: {} }),
    (e: unknown) => (e as { code?: string }).code === 'INVALID_INPUT',
  );
  await rt.close();
});

test('run：规划器产出步骤 → 执行 → Jev 任务级验收 → done', async () => {
  const page = new FakePage({ url: 'https://example.com/list', bodyText: 'result-page' });
  const judge = new FakeJudge({ decisions: [], checkP: 0.9 });
  const planned: FlowStep[] = [
    { id: 'p1', kind: 'action', action: 'navigate', value: 'https://example.com/search', expect: [{ kind: 'url_contains', value: 'search' }] },
    { id: 'p2', kind: 'assert', expect: [{ kind: 'text_present', value: 'result-page' }] },
  ];
  const planner = {
    plan: async () => JSON.parse(JSON.stringify(planned)) as FlowStep[],
    usage: () => ({ requests: 1, inputTokens: 50, outputTokens: 20 }),
  };
  const rt = makeRuntime(testConfig(), [page], judge, planner as never);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: ['https://example.com'],
  });
  const env = await rt.run(session.sessionId, {
    sessionId: session.sessionId,
    goal: '搜索并打开结果页',
    successCriteria: '结果页已打开且包含 result-page',
    values: {},
  });
  const final = await rt.waitEnvelope(env.taskId);
  assert.equal(final.status, 'done');
  assert.equal(final.goalVerification?.by, 'semantic');
  assert.equal(final.metrics.plannerRequests, 1); // 只规划一次
  assert.equal(judge.checkCalls.length, 1); // 任务级验收恰好一次
  assert.ok(judge.checkCalls[0]!.includes('result-page'));
  // 规划产物独立落库（plan_json），验收结果在 goalJson，互不覆盖
  assert.ok(store.getTask(final.taskId)!.planJson!.includes('"p1"'));
  assert.ok(store.getTask(final.taskId)!.goalJson!.includes('semantic'));
  await rt.close();
});

test('run：Jev 验收证据不足 → likely_done 暂停，不计 done', async () => {
  const page = new FakePage({ url: 'https://example.com/list', bodyText: 'x' });
  const judge = new FakeJudge({ decisions: [], checkP: 0.4 });
  const planner = { plan: async () => [{ id: 'a', kind: 'assert', expect: [] }] as FlowStep[] };
  const rt = makeRuntime(testConfig(), [page], judge, planner as never);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: ['https://example.com'],
  });
  const env = await rt.run(session.sessionId, {
    sessionId: session.sessionId,
    goal: 'g',
    successCriteria: '页面应显示完成标志',
    values: {},
  });
  const final = await rt.waitEnvelope(env.taskId);
  assert.equal(final.status, 'paused');
  assert.equal(final.pauseReason, 'likely_done');
  await rt.close();
});

test('候选页按授权域过滤；kind:new 的 pageId 基于真实下标', async () => {
  const pages = [
    new FakePage({ url: 'https://example.com/a' }),
    new FakePage({ url: 'https://other.com/b' }), // 不在授权域内
  ];
  const rt = makeRuntime(testConfig(), pages);
  // 多页且只授权 example.com：单页可自动绑定（唯一候选）
  const s = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  assert.equal(s.status, 'ready');
  assert.equal(s.pageId, 'p0');
  // 列表只包含授权域：other.com 被过滤
  const listed = await rt.listPages(s.sessionId);
  assert.deepEqual(listed.map((c) => c.pageId), ['p0']);
  // kind:new：新页追加到末尾（index 2），pageId 必须是真实下标（修复 indexOf 同一性 bug）
  const s2 = await rt.createSession({
    target: { kind: 'new', url: 'https://example.com/new' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  assert.equal(s2.pageId, 'p2');
  // target 非法输入被拒绝
  await assert.rejects(
    rt.createSession({ target: { kind: 'new', url: 'ftp://x' } as never, allowedOrigins: ['https://example.com'], modelOrigins: [] }),
    (e: unknown) => (e as { code?: string }).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    rt.createSession({ target: { kind: 'existing', pageId: 'tab-9' } as never, allowedOrigins: ['https://example.com'], modelOrigins: [] }),
    (e: unknown) => (e as { code?: string }).code === 'INVALID_INPUT',
  );
  await rt.close();
});

test('artifact 24h 保留期：终态任务的过期产物被清理（文件 + 元数据）', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  // 直接登记一个 25h 前的终态任务及其 artifact（模拟长期未清理的宿主）
  const now = Date.now();
  const oldTaskId = 'told1';
  store.insertTask({
    taskId: oldTaskId,
    sessionId: session.sessionId,
    mode: 'execute',
    status: 'done',
    pauseReason: null,
    revision: 1,
    requestJson: '{}',
    cursor: 0,
    varsJson: '{}',
    resultsJson: '[]',
    metricsJson: '{}',
    errorJson: null,
    goalJson: null,
    planJson: null,
    createdAt: now - 25 * 3600_000,
    updatedAt: now - 25 * 3600_000,
    deadlineAt: null,
  });
  const oldFile = path.join(dir, 'artifacts', oldTaskId, 'old.bin');
  mkdirSync(path.dirname(oldFile), { recursive: true });
  writeFileSync(oldFile, 'stale');
  store.putArtifact({ artifactId: 'aold', taskId: oldTaskId, filename: 'old.bin', size: 5, sha256: 'x', path: oldFile, createdAt: now - 25 * 3600_000 });

  rt.recoverOnStartup();
  assert.equal(existsSync(oldFile), false, '过期 artifact 文件应被删除');
  assert.equal(store.getArtifact('aold'), undefined, '过期 artifact 元数据应被删除');
  // 活跃/新产物不受影响：终态判定 + 保留期内 → 保留
  await rt.close();
});

test('grant 重复 approve 幂等（同 token 二次登记不崩溃）', async () => {
  process.env.JEV_BROWSER_APPROVAL_KEY = 'k2';
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'ok' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'risk', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: '确认支付' }, expect: [{ kind: 'text_present', value: 'ok' }] }]),
    values: {},
  });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  const { signature } = signGrant(
    { grantId: 'gdup', taskId: paused.taskId, actionRevision: paused.pendingApproval!.actionRevision, action: 'click', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    'k2',
  );
  rt.approveTask(paused.taskId, signature);
  rt.approveTask(paused.taskId, signature); // 重复登记：INSERT OR IGNORE
  const resumed = await rt.resumeTask(paused.taskId, { requestId: 'rd1' });
  const final = await rt.waitEnvelope(resumed.taskId);
  assert.equal(final.status, 'done');
  await rt.close();
});

test('capabilities：按配置推导，未实测能力标 unverified 而非 supported', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const caps = rt.capabilities();
  const byId = new Map(caps.map((c) => [c.id, c]));
  assert.equal(byId.get('attach')?.state, 'supported');
  assert.equal(byId.get('launch')?.state, 'unsupported');
  assert.equal(byId.get('page-observation')?.state, 'supported');
  assert.equal(byId.get('screenshot')?.state, 'supported');
  // 未实测能力：unverified（DESIGN §11：未知能力不标 supported）
  assert.equal(byId.get('dialog')?.state, 'unverified');
  assert.equal(byId.get('frame-access')?.state, 'unverified');
  assert.equal(byId.get('detach-preserves-browser')?.state, 'unverified');
  // 未配置上传目录：unsupported（默认拒绝一切上传）
  assert.equal(byId.get('upload')?.state, 'unsupported');
  // attach 模式：sandbox 不受控
  assert.equal(byId.get('sandbox')?.state, 'unsupported');
  await rt.close();
});

test('run 恢复 + allowReplan：未完成后缀重规划受 maxReplans 预算', async () => {
  const page = new FakePage({ url: 'https://example.com/start', bodyText: 'x' });
  // 首轮 goal 循环：Jev 选不出动作（action none）→ ambiguous 暂停
  const judge = new FakeJudge({ decisions: [{ action: 'none' }], checkP: 0.9 });
  const plannedSuffix2: FlowStep[] = [{ id: 'r1', kind: 'assert', expect: [] }];
  let replanCalls = 0;
  const planner = {
    plan: async () => [{ id: 'g1', kind: 'goal', goal: '完成目标', expect: [] }] as FlowStep[],
    replan: async (input: { completedStepIds: string[] }) => {
      replanCalls += 1;
      assert.deepEqual(input.completedStepIds, []); // 尚无已完成步骤
      return JSON.parse(JSON.stringify(plannedSuffix2)) as FlowStep[];
    },
    usage: () => ({ requests: 1 + replanCalls, inputTokens: 10, outputTokens: 5 }),
  };
  const cfg = testConfig();
  cfg.runtime.maxReplans = 1;
  const rt = makeRuntime(cfg, [page], judge, planner as never);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: ['https://example.com'],
  });
  const env = await rt.run(session.sessionId, {
    sessionId: session.sessionId,
    goal: 'g',
    successCriteria: '完成',
    values: {},
  });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pauseReason, 'ambiguous');
  // allowReplan 不能绕过 ambiguous 暂停的人工确认要求（安全语义）
  await assert.rejects(
    rt.resumeTask(env.taskId, { requestId: 'w1', allowReplan: true }),
    (e: unknown) => (e as { code?: string }).code === 'TASK_NOT_RESUMABLE',
  );
  // 重规划：后缀替换为 assert，验收通过 → done
  const resumed = await rt.resumeTask(env.taskId, { requestId: 'r1', allowReplan: true, rerunConfirmed: true });
  const final = await rt.waitEnvelope(resumed.taskId);
  assert.equal(final.status, 'done');
  assert.equal(final.metrics.replans, 1);
  assert.equal(replanCalls, 1);
  assert.ok(store.getTask(env.taskId)!.planJson!.includes('"r1"')); // 后缀已替换
  await rt.close();
});

test('snapshot：跨会话窃读被预约拦截；本会话暂停任务期间允许只读', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x', clickError: new Error('TimeoutError: 30000ms exceeded') });
  const rt = makeRuntime(testConfig(), [page]);
  const s1 = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  // 用另一个会话绑定同一 profile 页面（同宿主多会话场景）
  const s2 = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  // s1 产生未知在途动作 → 隔离 + profile 预约（paused）
  const env = await rt.execute(s1.sessionId, {
    sessionId: s1.sessionId,
    steps: flow([{ id: 't', kind: 'action', action: 'click', target: { by: 'css', selector: '#x' }, expect: [{ kind: 'url_contains', value: 'never' }] }]),
    values: {},
  });
  await rt.waitEnvelope(env.taskId);
  // s2 的快照被预约拦截（防窃读）
  await assert.rejects(
    rt.snapshot(s2.sessionId),
    (e: unknown) => (e as { code?: string }).code === 'SESSION_BUSY',
  );
  // s1 自身（预约任务所属会话）允许只读
  const obs = await rt.snapshot(s1.sessionId);
  assert.ok(obs);
  await rt.close();
});

test('evidence：断言失败进入 envelope.evidence（DESIGN §8.2）', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'bad', kind: 'assert', expect: [{ kind: 'text_present', value: 'absent-text' }] }]),
    values: {},
  });
  const final = await rt.waitEnvelope(env.taskId);
  assert.equal(final.status, 'failed');
  assert.ok(final.evidence?.length);
  assert.ok(JSON.stringify(final.evidence).includes('absent-text'));
  await rt.close();
});

test('unknown 隔离：超时未知动作后，新写任务被拒绝、只读放行', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x', clickError: new Error('TimeoutError: 30000ms exceeded') });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 't1', kind: 'action', action: 'click', target: { by: 'css', selector: '#x' }, expect: [{ kind: 'url_contains', value: 'never' }] }]),
    values: {},
  });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.error?.code, 'ACTION_OUTCOME_UNKNOWN');

  // 新写任务（fill 是写动作）被隔离拒绝
  const writeEnv = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'w', kind: 'action', action: 'fill', target: { by: 'css', selector: '#y' }, value: 'v', expect: [{ kind: 'text_present', value: 'v' }] }]),
    values: {},
  });
  const writeFinal = await rt.waitEnvelope(writeEnv.taskId);
  assert.equal(writeFinal.status, 'failed');
  assert.equal(writeFinal.error?.code, 'BROWSER_BUSY');

  // 取消隔离中的任务（释放预约；隔离记录仍在），只读任务放行
  await rt.cancelTask(paused.taskId, { requestId: 'cx' });
  const readEnv = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'r', kind: 'assert', expect: [] }]),
    values: {},
  });
  const readFinal = await rt.waitEnvelope(readEnv.taskId);
  assert.equal(readFinal.status, 'done');
  await rt.close();
});

test('崩溃恢复：遗留 running → paused(interrupted)；需 rerunConfirmed 才能恢复', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  // 直接插入一条 running 任务（模拟宿主崩溃时未收尾的状态，避免队列竞态）
  const taskId = 'tcrash1';
  const now = Date.now();
  store.insertTask({
    taskId,
    sessionId: session.sessionId,
    mode: 'execute',
    status: 'running',
    pauseReason: null,
    revision: 3,
    requestJson: JSON.stringify({
      sessionId: session.sessionId,
      steps: [{ id: 'w', kind: 'action', action: 'wait', target: { by: 'css', selector: '#z' }, expect: [{ kind: 'visible', target: { by: 'css', selector: '#z' } }] }],
      values: {},
    }),
    cursor: 0,
    varsJson: '{}',
    resultsJson: '[]',
    metricsJson: '{}',
    errorJson: null,
    goalJson: null,
    planJson: null,
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + 600_000,
  });
  const rec = rt.recoverOnStartup();
  const row = store.getTask(taskId)!;
  assert.equal(row.status, 'paused');
  assert.equal(row.pauseReason, 'interrupted');
  assert.ok(rec.recovered >= 1);
  // 未确认的 resume 拒绝
  await assert.rejects(
    rt.resumeTask(taskId, { requestId: 'x1' }),
    /rerunConfirmed/,
  );
  // 显式确认后恢复（wait 目标在 FakePage 中可见 → done，状态机路径完整）
  const resumed = await rt.resumeTask(taskId, { requestId: 'x2', rerunConfirmed: true });
  assert.equal(resumed.status, 'queued');
  const final = await rt.waitEnvelope(taskId);
  assert.equal(final.status, 'done');
  await rt.close();
});

test('secretRef：缺环境变量暂停 needs_input；补齐后恢复成功', async () => {
  const page = new FakePage({ url: 'https://example.com/login', bodyText: 'welcome' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession({
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute(session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([
      { id: 'fill', kind: 'action', action: 'fill', target: { by: 'css', selector: '#pw' }, valuesRef: 'pw', expect: [{ kind: 'text_present', value: 'welcome' }] },
    ]),
    values: { pw: { secretRef: 'PW' } } as never,
  });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pauseReason, 'needs_input');
  // 补齐 secret 后恢复
  process.env.JEV_BROWSER_SECRET_PW = 's3cret';
  const resumed = await rt.resumeTask(paused.taskId, { requestId: 's1' });
  const final = await rt.waitEnvelope(resumed.taskId);
  assert.equal(final.status, 'done');
  // secret 不落盘：vars 中只应有解析后的引用在内存，库里的 varsJson 不含请求 values
  const row = store.getTask(resumed.taskId)!;
  assert.ok(!row.requestJson.includes('s3cret'));
  assert.ok(!row.varsJson.includes('s3cret'));
  await rt.close();
});

// ---------------------------------------------------------------------------
// 校验工具
// ---------------------------------------------------------------------------

test('validateExecuteSteps：空步骤/非法字段拒绝', () => {
  assert.throws(() => validateExecuteSteps([]), /不能为空/);
  assert.throws(
    () => validateExecuteSteps([{ id: 'x', kind: 'quantum' } as never]),
    /kind 非法/,
  );
});

test('resolveValues：非 secret 值直传；secret 缺失抛暂停', () => {
  const out = resolveValues({ a: 'plain', n: 3 });
  assert.deepEqual(out, { a: 'plain', n: 3 });
  assert.throws(() => resolveValues({ s: { secretRef: 'NOPE' } }), (e: unknown) => (e as Error).name === 'PauseSignal');
});
