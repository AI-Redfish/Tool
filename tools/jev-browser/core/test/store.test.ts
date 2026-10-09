import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/store.js';

function newStore(): { store: TaskStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-store-'));
  return { store: new TaskStore(path.join(dir, 'tasks.db')), dir };
}

function taskRow(taskId: string): Parameters<TaskStore['insertTask']>[0] {
  return {
    taskId,
    sessionId: 's1',
    mode: 'execute',
    status: 'queued',
    pauseReason: null,
    revision: 0,
    requestJson: '{}',
    cursor: 0,
    varsJson: '{}',
    resultsJson: '[]',
    metricsJson: '{}',
    errorJson: null,
    goalJson: null,
    planJson: null,
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: null,
  };
}

test('幂等：同键同哈希返回原任务；同键不同哈希冲突', () => {
  const { store } = newStore();
  store.putIdempotent('k1', 'h1', 't1');
  assert.deepEqual(store.findIdempotent('k1'), { bodyHash: 'h1', taskId: 't1' });
  assert.throws(() => store.putIdempotent('k1', 'h2', 't2'), /请求体不同/);
});

test('审批 grant：原子消费一次', () => {
  const { store } = newStore();
  store.putGrant({ grantId: 'g1', taskId: 't1', actionRevision: 2, token: 'sig', expiresAt: Date.now() + 60_000 });
  assert.ok(store.findGrant('t1', 2));
  assert.equal(store.consumeGrant('g1'), true);
  assert.equal(store.consumeGrant('g1'), false);
  assert.equal(store.findGrant('t1', 2), undefined);
});

test('乐观 revision 转移：旧 revision 写入失败', () => {
  const { store } = newStore();
  store.insertTask(taskRow('t1'));
  assert.equal(store.transition('t1', 0, { status: 'running' }), 1);
  const row = store.getTask('t1')!;
  assert.equal(row.status, 'running');
  assert.equal(row.revision, 1);
  // 用旧 revision 再转移 → 失败
  assert.equal(store.transition('t1', 0, { status: 'done' }), 0);
  assert.equal(store.getTask('t1')!.status, 'running');
});

test('动作账本与崩溃恢复查询', () => {
  const { store } = newStore();
  store.insertTask(taskRow('t1'));
  store.setActionState('t1', 1, 'prepared', '{"action":"click"}');
  store.setActionState('t1', 2, 'in_flight');
  store.setActionState('t1', 2, 'unknown', undefined, '{"reason":"timeout"}');
  assert.equal(store.maxActionSeq('t1'), 2);
  const unresolved = store.unresolvedActions();
  assert.deepEqual(unresolved, [{ taskId: 't1', seq: 1, state: 'prepared' }]);
});
