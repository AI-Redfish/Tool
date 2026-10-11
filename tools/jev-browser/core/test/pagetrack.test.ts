import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollNewPages } from '../src/pagetrack.js';

// ---------------------------------------------------------------------------
// 新标签页检测（回归：此前「任务一结束只查一次」会稳定漏报）
// ---------------------------------------------------------------------------

const p1 = { pageId: 'p1' };
const p0 = { pageId: 'p0' };

test('pollNewPages：新页晚于任务落定时仍能被发现（真实定时器）', async () => {
  const pages = [{ ...p1 }];
  // 模拟浏览器异步创建 target=_blank 页面：150ms 后才出现
  setTimeout(() => pages.push({ pageId: 'p2' }), 150);
  const opened = await pollNewPages([p1], async () => [...pages], { waitMs: 1000, pollMs: 30 });
  assert.deepEqual(opened.map((p) => p.pageId), ['p2'], '轮询窗口内出现即应被捕获');
});

test('pollNewPages：用注入的 sleep 驱动（确定性，不等真实时间）', async () => {
  const pages = [{ ...p1 }];
  let ticks = 0;
  const sleep = async (): Promise<void> => {
    ticks += 1;
    if (ticks === 3) pages.push({ pageId: 'p2' });
  };
  const opened = await pollNewPages([p1], async () => [...pages], { waitMs: 10_000, pollMs: 1, sleep });
  assert.equal(ticks, 3, '第 3 次轮询时新页出现，应立即返回而不是等满窗口');
  assert.deepEqual(opened.map((p) => p.pageId), ['p2']);
});

test('pollNewPages：waitMs=0 只查一次（确定不会开新页时不付这份等待）', async () => {
  let calls = 0;
  const list = async (): Promise<Array<{ pageId: string }>> => {
    calls += 1;
    return [{ ...p1 }];
  };
  const opened = await pollNewPages([p1], list, { waitMs: 0 });
  assert.deepEqual(opened, []);
  assert.equal(calls, 1);
});

test('pollNewPages：窗口耗尽仍无新页 → 空数组（不抛错、不无限等）', async () => {
  let calls = 0;
  const sleep = async (): Promise<void> => {
    calls += 1;
  };
  const opened = await pollNewPages([p1], async () => [{ ...p1 }], { waitMs: 0, sleep });
  assert.deepEqual(opened, []);
  assert.equal(calls, 0, 'waitMs=0 时不该进入轮询');
});

test('pollNewPages：相对 before 判定，已有页不会被误报为新页', async () => {
  const pages = [{ pageId: 'p0' }, { pageId: 'p1' }];
  const opened = await pollNewPages([p0, p1], async () => [...pages], { waitMs: 0 });
  assert.deepEqual(opened, []);
});
