import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FlowExecutor } from '../src/flow.js';
import type { FlowRunContext } from '../src/flow.js';
import { FsArtifactSink } from '../src/executor.js';
import { PauseSignal, err } from '../src/errors.js';
import { FakePage } from './fakes.js';
import type { FlowStep } from '../src/types.js';

function makeCtx(page: FakePage, overrides: Partial<FlowRunContext> = {}): FlowRunContext {
  return {
    vars: {},
    values: {},
    artifacts: new FsArtifactSink(mkdtempSync(path.join(tmpdir(), 'jev-flow-'))),
    ledger: { prepared() {}, inFlight() {}, finished() {} },
    nextActionRevision: (() => {
      let n = 0;
      return () => ++n;
    })(),
    actionTimeoutMs: 1000,
    cancelFlag: { cancelled: false },
    maxSteps: 100,
    maxActions: 100,
    ...overrides,
  };
}

const extractItems: FlowStep = {
  id: 'ex', kind: 'extract',
  target: { by: 'css', selector: '.item' },
  fields: ['text', 'count'], saveAs: 'items',
};

test('extract + assert + var_equals：变量在步骤间流转', async () => {
  const page = new FakePage({ url: 'https://example.com/list', bodyText: 'hello' });
  const ctx = makeCtx(page);
  const flow = new FlowExecutor(page, ctx);
  const r = await flow.run([
    extractItems,
    { id: 'as', kind: 'assert', expect: [{ kind: 'var_equals', variable: 'items.count', value: 1 }] },
  ]);
  assert.equal(r.stepResults.filter((s) => s.status === 'done').length, 2);
  assert.deepEqual((ctx.vars['items'] as { count: number }).count, 1);
});

test('branch 只在相等时执行 then', async () => {
  const page = new FakePage({});
  const ctx = makeCtx(page);
  ctx.vars['flag'] = 'yes';
  const flow = new FlowExecutor(page, ctx);
  const r = await flow.run([
    { id: 'br', kind: 'branch', variable: 'flag', equals: 'no', then: [{ id: 'nav', kind: 'action', action: 'wait', value: 1, expect: [] }] },
  ]);
  assert.equal(r.stepResults.find((s) => s.id === 'br')?.status, 'done');
  // equals 不匹配：then 中的步骤没有执行结果
  assert.equal(r.stepResults.some((s) => s.id === 'nav'), false);
});

test('forEach 有界遍历：实际迭代计入结果；未处理完 → 暂停并记录断点', async () => {
  const page = new FakePage({});
  const ctx = makeCtx(page);
  ctx.vars['items'] = [1, 2, 3];
  const r = await new FlowExecutor(page, ctx).run([
    { id: 'fe', kind: 'forEach', itemsVar: 'items', itemVar: 'item', maxItems: 10, body: [{ id: 'b', kind: 'assert', expect: [] }] },
  ]);
  assert.equal(r.stepResults.find((s) => s.id === 'fe')?.iterations, 3);

  ctx.vars['big'] = [1, 2, 3, 4, 5];
  await assert.rejects(
    new FlowExecutor(page, ctx).run([
      { id: 'fe2', kind: 'forEach', itemsVar: 'big', itemVar: 'item', maxItems: 2, body: [{ id: 'b2', kind: 'assert', expect: [] }] },
    ]),
    (e: unknown) => e instanceof PauseSignal && /2\/5/.test(e.message),
  );
  assert.equal(ctx.vars['big.processed'], 2);
});

test('forEach 断点续跑：processed 计数跳过已完成迭代', async () => {
  const page = new FakePage({});
  const vars: Record<string, unknown> = { items: ['a', 'b', 'c'], 'items.processed': 1 };
  const ctx = makeCtx(page);
  ctx.vars = vars;
  const flow = new FlowExecutor(page, ctx);
  const r = await flow.run([
    { id: 'fe', kind: 'forEach', itemsVar: 'items', itemVar: 'item', maxItems: 10, body: [{ id: 'b', kind: 'assert', expect: [] }] },
  ]);
  assert.equal(r.stepResults.find((s) => s.id === 'fe')?.iterations, 3);
  assert.equal(vars['items.processed'], 3); // 从 1 续跑到 3，不重跑第 1 项
});

test('forEach 迭代项可经 valuesRef 引用（values 缺失时回退到流程变量）', async () => {
  const locatorLog: string[] = [];
  const page = new FakePage({ bodyText: 'seed', locatorLog });
  const ctx = makeCtx(page);
  ctx.vars['items'] = ['term-1', 'term-2'];
  const r = await new FlowExecutor(page, ctx).run([
    {
      id: 'fe', kind: 'forEach', itemsVar: 'items', itemVar: 'item', maxItems: 10,
      body: [{ id: 'f', kind: 'action', action: 'fill', target: { by: 'css', selector: '#q' }, valuesRef: 'item', expect: [] }],
    },
  ]);
  assert.equal(r.stepResults.find((s) => s.id === 'fe')?.status, 'done');
  const fills = locatorLog.filter((c) => c.startsWith('fill:'));
  assert.deepEqual(fills, ['fill:term-1', 'fill:term-2']);
});

test('maxSteps / maxActions 预算耗尽 → BUDGET_EXCEEDED', async () => {
  const page = new FakePage({});
  {
    const ctx = makeCtx(page, { maxSteps: 2 });
    await assert.rejects(
      new FlowExecutor(page, ctx).run([
        { id: 'a', kind: 'assert', expect: [] },
        { id: 'b', kind: 'assert', expect: [] },
        { id: 'c', kind: 'assert', expect: [] },
      ]),
      (e: unknown) => (e as { code?: string }).code === 'BUDGET_EXCEEDED',
    );
  }
  {
    const ctx = makeCtx(page, { maxActions: 1 });
    await assert.rejects(
      new FlowExecutor(page, ctx).run([
        { id: 'a1', kind: 'action', action: 'wait', value: 1, expect: [] },
        { id: 'a2', kind: 'action', action: 'wait', value: 1, expect: [] },
      ]),
      (e: unknown) => (e as { code?: string }).code === 'BUDGET_EXCEEDED',
    );
  }
});

test('取消旗标：剩余步骤 skipped', async () => {
  const page = new FakePage({});
  const ctx = makeCtx(page);
  ctx.cancelFlag.cancelled = true;
  const r = await new FlowExecutor(page, ctx).run([
    { id: 'x', kind: 'assert', expect: [] },
    { id: 'y', kind: 'assert', expect: [] },
  ]);
  assert.deepEqual(r.stepResults.map((s) => s.status), ['skipped', 'skipped']);
});

test('checkDeadline 抛出 → 传播并终止', async () => {
  const page = new FakePage({});
  const ctx = makeCtx(page, {
    checkDeadline: () => { throw err('ACTION_TIMEOUT', 'deadline'); },
  });
  await assert.rejects(
    new FlowExecutor(page, ctx).run([{ id: 'a', kind: 'assert', expect: [] }]),
    /deadline/,
  );
});

test('goal 步骤走 goalRunner（局部循环注入点）', async () => {
  const page = new FakePage({});
  let called = false;
  const ctx = makeCtx(page, {
    goalRunner: async (_page, step) => {
      called = true;
      assert.equal(step.goal, '点击提交');
    },
  });
  await new FlowExecutor(page, ctx).run([{ id: 'g', kind: 'goal', goal: '点击提交', expect: [] }]);
  assert.ok(called);
});
