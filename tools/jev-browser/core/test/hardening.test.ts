import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyExpects, evidenceUrl } from '../src/locator.js';
import { parseShorthandStep } from '../src/shorthand.js';
import type { PagePort } from '../src/ports.js';
import { renderObservation, slimObservation, type PageObservation } from '../src/observe.js';
import { FakePage } from './fakes.js';
import type { FlowStep } from '../src/types.js';

// ---------------------------------------------------------------------------
// 断言表达力补强：值断言与「元素消失」断言
// ---------------------------------------------------------------------------

const loc = { by: 'css' as const, selector: '#kw' };

test('value_equals：输入值相符通过、不符则给出可读的失败原因', async () => {
  const ok = await verifyExpects(new FakePage({ locatorValue: '虎皮鹦鹉' }), [{ kind: 'value_equals', target: loc, value: '虎皮鹦鹉' }], { vars: {} }, 1000);
  assert.equal(ok.ok, true);

  const bad = await verifyExpects(new FakePage({ locatorValue: '鬼叔黍' }), [{ kind: 'value_equals', target: loc, value: '虎皮鹦鹉' }], { vars: {}, retryMs: 0 }, 1000);
  assert.equal(bad.ok, false);
  assert.match(bad.failures[0]!.reason, /输入值 "鬼叔黍" ≠ "虎皮鹦鹉"/);
});

test('value_contains：子串命中即可（受控组件只写入一部分时能给出准确判断）', async () => {
  const r = await verifyExpects(new FakePage({ locatorValue: '关键词：虎皮鹦鹉' }), [{ kind: 'value_contains', target: loc, value: '虎皮鹦鹉' }], { vars: {} }, 1000);
  assert.equal(r.ok, true);
});

test('not_visible：元素已消失通过，仍可见则失败（删除/关闭类操作的真后置条件）', async () => {
  const gone = await verifyExpects(new FakePage({ locatorVisible: false }), [{ kind: 'not_visible', target: loc }], { vars: {} }, 1000);
  assert.equal(gone.ok, true);

  const still = await verifyExpects(new FakePage({ locatorVisible: true }), [{ kind: 'not_visible', target: loc }], { vars: {}, retryMs: 0 }, 1000);
  assert.equal(still.ok, false);
  assert.match(still.failures[0]!.reason, /仍然可见/);
});

// ---------------------------------------------------------------------------
// 证据瘦身：URL 收敛
// ---------------------------------------------------------------------------

test('evidenceUrl：短 URL 原样保留', () => {
  assert.equal(evidenceUrl('https://www.bilibili.com/video/BV1ZP6BBvEbB/'), 'https://www.bilibili.com/video/BV1ZP6BBvEbB/');
});

test('evidenceUrl：超长带跟踪参数的 URL 收敛为 origin+path', () => {
  const long = `https://www.bilibili.com/video/BV1ZP6BBvEbB/?trackid=${'x'.repeat(400)}&spm_id_from=333.788`;
  assert.equal(evidenceUrl(long), 'https://www.bilibili.com/video/BV1ZP6BBvEbB/');
});

// ---------------------------------------------------------------------------
// 观察瘦身：去掉与 name 同源的 text、forModel 紧凑渲染
// ---------------------------------------------------------------------------

function obs(): PageObservation {
  return {
    snapshotId: 's1',
    url: 'https://example.com/',
    title: 'T',
    elements: [
      { i: 0, role: 'link', name: '首页', tag: 'a', text: '首页' },
      { i: 1, role: 'button', name: '搜索', tag: 'button', text: '搜索', disabled: true },
      { i: 2, role: 'textbox', name: '关键词', tag: 'input', text: '关键词', hasValue: true },
    ],
    counts: { total: 3 },
    truncated: false,
  };
}

test('slimObservation：剥离与 name 同源的 text，其余字段保留', () => {
  const slim = slimObservation(obs());
  assert.equal(slim.elements.length, 3);
  for (const e of slim.elements) assert.equal(e.text, undefined);
  assert.equal(slim.elements[0]!.name, '首页');
  assert.equal(slim.elements[1]!.disabled, true);
  assert.equal(slim.elements[2]!.hasValue, true);
});

test('slimObservation：text 与 name 不同时保留（未来若两者分叉不会被误删）', () => {
  const o = obs();
  o.elements[0]!.text = '不同的文本';
  const slim = slimObservation(o);
  assert.equal(slim.elements[0]!.text, '不同的文本');
});

test('renderObservation：一行一个元素，标记位可见', () => {
  const lines = renderObservation(obs());
  assert.deepEqual(lines, [
    '[0] link "首页"',
    '[1] button "搜索" [disabled]',
    '[2] textbox "关键词" [hasValue]',
    '# 共 3 个元素',
  ]);
});

// ---------------------------------------------------------------------------
// press：只写 value 时不再被静默忽略
// ---------------------------------------------------------------------------

test('press：只写 value 时按 value 的键，而不是静默回落 Enter', async () => {
  const { performAction } = await import('../src/executor.js');
  const page = new FakePage();
  const step: FlowStep = { id: 'p1', kind: 'action', action: 'press', value: 'Tab', expect: [{ kind: 'url_contains', value: 'example.com' }] };
  await performAction(page, step as never, {
    vars: {}, values: {}, artifacts: { save: () => ({ artifactId: 'a1', filename: 'f', size: 0, sha256: '', path: '' }), saveDownload: () => ({ artifactId: 'a1', filename: 'f', size: 0, sha256: '', path: '' }), dir: () => '' },
    ledger: { prepared: () => {}, inFlight: () => {}, finished: () => {} },
    actionRevision: 1, actionTimeoutMs: 1000, cancelFlag: { cancelled: false },
  } as never);
  assert.ok(page.calls.includes('key:Tab'), `实际调用：${page.calls.join(',')}`);
});

// ---------------------------------------------------------------------------
// 本轮新增：断言重试 / 简写 evaluate / 标题去重
// ---------------------------------------------------------------------------

/** 最小 PagePort 桩：只实现 verifyExpects 会用到的方法，url() 按调用次数依次返回。 */
function urlSequencePage(urls: string[]): { page: PagePort; calls: () => number } {
  let n = 0;
  const page = {
    url: () => urls[Math.min(n++, urls.length - 1)],
  } as unknown as PagePort;
  return { page, calls: () => n };
}

test('断言重试：SPA 效果晚到不再被误判为失败', async () => {
  const { page, calls } = urlSequencePage(['https://a/', 'https://a/', 'https://b/search']);
  const r = await verifyExpects(page, [{ kind: 'url_contains', value: 'search' }], { vars: {}, retryMs: 2000 }, 5000);
  assert.equal(r.ok, true, '重试窗口内出现即通过');
  assert.ok(calls() >= 3, `应重试多次，实际 url() 调用 ${calls()} 次`);
});

test('断言重试：retryMs=0 时退回单发（测试与「立刻失败」语义）', async () => {
  const { page, calls } = urlSequencePage(['https://a/', 'https://b/search']);
  const r = await verifyExpects(page, [{ kind: 'url_contains', value: 'search' }], { vars: {}, retryMs: 0 }, 5000);
  assert.equal(r.ok, false, '不重试 → 直接失败，不吸收延迟');
  assert.ok(calls() <= 2, `单发判定（含失败原因里的一次 url 读取），实际 ${calls()} 次`);
});

test('断言重试：var_equals 不重试（任务内事实，重试只会白等）', async () => {
  const { page, calls } = urlSequencePage(['https://a/']);
  const r = await verifyExpects(page, [{ kind: 'var_equals', variable: 'x', value: 1 }], { vars: { x: 2 }, retryMs: 2000 }, 5000);
  assert.equal(r.ok, false);
  assert.equal(calls(), 0);
});

test('简写 evaluate：参数里的箭头函数不被 "=>" 切坏', () => {
  const s = parseShorthandStep('evaluate:(() => document.title)()') as { script?: string; expect: unknown[] };
  assert.equal(s.script, '(() => document.title)()');
  assert.deepEqual(s.expect, []);
});

test('slimObservation：同名标题在链接之后出现时被剥掉', () => {
  const o: PageObservation = {
    snapshotId: 's', url: 'https://e.com/', title: 'T', truncated: false, counts: { total: 4 },
    elements: [
      { i: 0, role: 'link', name: '某视频标题', tag: 'a', text: '某视频标题' },
      { i: 1, role: 'heading', name: '某视频标题', tag: 'h3', text: '某视频标题' },
      { i: 2, role: 'heading', name: '独有标题', tag: 'h1', text: '独有标题' },
      { i: 3, role: 'link', name: '另一个', tag: 'a', text: '另一个' },
    ],
  };
  const slim = slimObservation(o);
  assert.deepEqual(slim.elements.map((e) => `${e.role}:${e.name}`), ['link:某视频标题', 'heading:独有标题', 'link:另一个']);
  assert.equal(slim.counts.total, 3);
});
