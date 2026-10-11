import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TypeSafeJudge, type RoundObservationInput } from '../src/judge.js';
import { defaultConfig } from '../src/config.js';
import type { PageObservation } from '../src/observe.js';

// ---------------------------------------------------------------------------
// Jev 适配：请求体瘦身、序号对齐、失败映射（离线假客户端，不发网络请求）
// ---------------------------------------------------------------------------

function obs(): PageObservation {
  return {
    snapshotId: 's',
    url: 'https://example.com/',
    title: 'T',
    truncated: false,
    counts: { total: 2 },
    elements: [
      { i: 0, role: 'link', name: '苹果', tag: 'a', text: '苹果' },
      { i: 1, role: 'button', name: '提交', tag: 'button', text: '提交', disabled: true },
    ],
  };
}

interface Captured {
  state: { elements: Array<{ i: number; role: string; name: string }> };
}

function judgeWithCapture(): { judge: TypeSafeJudge; captured: Captured[] } {
  const captured: Captured[] = [];
  const client = {
    systemOne: async (req: Captured): Promise<unknown> => {
      captured.push(req);
      return {
        model: 'jev-test',
        usage: { input_tokens: 3, output_tokens: 1 },
        answers: {
          done: { noul: 0 },
          doneConfirm: { noul: 0 },
          blocked: { noul: 0 },
          error: { noul: 0 },
          tool: { choice: 'click' },
          target: { choice: 'c1', probabilities: { c1: 0.9 } },
          value: { choice: 'none' },
        },
      };
    },
  };
  return { judge: new TypeSafeJudge(defaultConfig().jev, { client: client as never, env: {} }), captured };
}

function input(over: Partial<RoundObservationInput> = {}): RoundObservationInput {
  return {
    goal: '点提交',
    observation: obs(),
    valuesKeys: [],
    recentActions: [],
    diff: { urlChanged: false, elementsAdded: 0, elementsRemoved: 0 },
    ...over,
  };
}

test('Jev 请求体：只发 role/name/序号，不带同源的 text 与从不参与提问的 tag', async () => {
  const { judge, captured } = judgeWithCapture();
  await judge.decideRound(input());
  assert.deepEqual(captured[0]!.state.elements, [
    { i: 0, role: 'link', name: '苹果' },
    { i: 1, role: 'button', name: '提交' },
  ]);
});

test('Jev 请求体：序号按候选切片对齐（修掉「问题说 i、criteria 说 idx」的自相矛盾）', async () => {
  const { judge, captured } = judgeWithCapture();
  // candidateLimit=1 → scopeCandidates 按关键词重排并截断，候选只剩「提交」（原下标是 1）
  await judge.decideRound(input({ candidateLimit: 1 }));
  const sent = captured[0]!.state.elements;
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.name, '提交');
  assert.equal(sent[0]!.i, 0, '切片内序号应为 0，而不是原观察里的 1');
});

test('decision.candidates 保留完整内部对象（定位器构造仍需要 text）', async () => {
  const { judge } = judgeWithCapture();
  const d = await judge.decideRound(input());
  assert.equal(d.targetIndex, 1);
  assert.equal(d.candidates[1]!.text, '提交');
  assert.equal(d.candidates[1]!.disabled, true);
});

test('Jev 候选裁剪：超上限只发前 80 个，且排序按「目标相关性 > 是否在视口内」', async () => {
  // 100 个元素：只有 2 个在视口内；其中 1 个被目标点名（但不在视口内）
  const elements = Array.from({ length: 100 }, (_, i) => ({
    i,
    role: 'link',
    name: `普通条目${i}`,
    tag: 'a',
    text: `普通条目${i}`,
    ...(i < 2 ? { inViewport: true } : {}),
  }));
  // 第 90 个元素才是目标点名的那个（既不在视口内、也不在前 80）
  elements[90] = { i: 90, role: 'button', name: '提交订单', tag: 'button', text: '提交订单' };
  const observation: PageObservation = { snapshotId: 's', url: 'https://e.com/', title: 'T', truncated: false, counts: { total: 100 }, elements };

  const { judge, captured } = judgeWithCapture();
  await judge.decideRound({ goal: '点击 提交订单', observation, valuesKeys: [], recentActions: [], diff: { urlChanged: false, elementsAdded: 0, elementsRemoved: 0 } });
  const sent = captured[0]!.state.elements;
  assert.ok(sent.length <= 80, `候选应被裁到 80 以内，实际 ${sent.length}`);
  assert.equal(sent[0]!.name, '提交订单', '被目标点名的元素必须排第一（哪怕不在视口内、原下标第 90）');
  assert.equal(sent[0]!.i, 0, '序号按切片重排');
  assert.equal(sent[1]!.name, '普通条目0', '其次是视口内元素（同分按文档顺序）');
});

test('目标置信度：优先取服务端给的 confidence（校准值），而不是原始概率', async () => {
  const captured: Captured[] = [];
  const client = {
    systemOne: async (req: Captured): Promise<unknown> => {
      captured.push(req);
      return {
        model: 'jev-test',
        usage: {},
        answers: {
          done: { noul: 0 }, doneConfirm: { noul: 0 }, blocked: { noul: 0 }, error: { noul: 0 },
          tool: { choice: 'click' },
          // confidence 与 probabilities 故意给不同值：闸门应当用 confidence
          target: { choice: 'c1', confidence: 0.62, probabilities: { c1: 0.91 } },
          value: { choice: 'none' },
        },
      };
    },
  };
  const judge = new TypeSafeJudge(defaultConfig().jev, { client: client as never, env: {} });
  const d = await judge.decideRound(input());
  assert.equal(d.targetConfidence, 0.62, 'confidence 优先');
  assert.equal((d.probabilities.target as Record<string, number>).c1, 0.91, '原始概率仍原样保留供审计');
});

test('Jev 调用失败映射成可操作的 JEV_UNAVAILABLE（点明端点这个修复口）', async () => {
  const client = {
    systemOne: async (): Promise<never> => {
      throw new Error('451 {"title":"Typesafe is not available in your region.","status":451}');
    },
  };
  const judge = new TypeSafeJudge(defaultConfig().jev, { client: client as never, env: {} });
  await assert.rejects(
    judge.decideRound(input()),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, 'JEV_UNAVAILABLE');
      assert.match(err.message ?? '', /TYPESAFE_BASE_URL/, '必须给出端点这条修复路径');
      assert.match(err.message ?? '', /地区限制/, '要说清 451 的含义');
      return true;
    },
  );
});
