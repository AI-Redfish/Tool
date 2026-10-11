import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandShorthandSteps, parseShorthandStep } from '../src/shorthand.js';
import { validateExecuteSteps } from '../src/taskservice.js';
import type { ActionStep } from '../src/types.js';

/** 简写解析结果是 action|goal 的联合；这里只取 action 分支来断言动作字段。 */
const actionStep = (raw: string): ActionStep => parseShorthandStep(raw) as ActionStep;

// ---------------------------------------------------------------------------
// 紧凑步骤简写：语法解析
// ---------------------------------------------------------------------------

test('简写：点击 + 后置条件', () => {
  const s = actionStep('click:role/button/搜索 => url_contains:/search');
  assert.equal(s.action, 'click');
  assert.deepEqual(s.target, { by: 'role', role: 'button', name: '搜索' });
  assert.deepEqual(s.expect, [{ kind: 'url_contains', value: '/search' }]);
});

test('简写：fill 的值分隔符取最后一个等号，CSS 里的等号不被误切', () => {
  const s = actionStep('fill:css/input[type=password]=hunter2 => value_equals:css/input[type=password]=hunter2');
  assert.equal(s.action, 'fill');
  assert.deepEqual(s.target, { by: 'css', selector: 'input[type=password]' });
  assert.equal(s.value, 'hunter2');
  assert.deepEqual(s.expect, [
    { kind: 'value_equals', target: { by: 'css', selector: 'input[type=password]' }, value: 'hunter2' },
  ]);
});

test('简写：navigate 的 URL 含冒号与斜杠也不被切坏', () => {
  const s = actionStep('navigate:https://search.bilibili.com/all?keyword=x => url_contains:search.bilibili.com');
  assert.equal(s.action, 'navigate');
  assert.equal(s.value, 'https://search.bilibili.com/all?keyword=x');
  assert.deepEqual(s.expect, [{ kind: 'url_contains', value: 'search.bilibili.com' }]);
});

test('简写：值以 $ 开头转为 valuesRef（敏感值可走 secretRef）', () => {
  const s = actionStep('fill:css/#pw=$password');
  assert.equal(s.valuesRef, 'password');
  assert.equal(s.value, undefined);
});

test('简写：多条后置条件用分号分隔', () => {
  const s = actionStep('click:text/提交订单 => not_visible:css/.loading; url_contains:/done');
  assert.deepEqual(s.expect, [
    { kind: 'not_visible', target: { by: 'css', selector: '.loading' } },
    { kind: 'url_contains', value: '/done' },
  ]);
});

test('简写：无参动作与数值动作', () => {
  assert.equal(actionStep('screenshot').action, 'screenshot');
  assert.deepEqual(actionStep('screenshot').expect, []);
  assert.equal(actionStep('wait:2000').value, 2000);
  assert.deepEqual(actionStep('wait:css/.card').target, { by: 'css', selector: '.card' });
  assert.equal(actionStep('press:Tab').key, 'Tab');
  assert.equal(actionStep('scroll:800').value, 800);
  assert.equal(actionStep('evaluate:document.title').script, 'document.title');
});

test('简写：goal 动词产出 Jev 语义步骤（可带后置条件）', () => {
  const s = parseShorthandStep('goal:打开搜索结果里的第二个视频 => url_contains:/video/');
  assert.equal(s.kind, 'goal');
  assert.equal((s as { goal: string }).goal, '打开搜索结果里的第二个视频');
  assert.deepEqual(s.expect, [{ kind: 'url_contains', value: '/video/' }]);
});

test('简写：定位器末尾 "!" 表示精确匹配（列表页同名元素多时的解药）', () => {
  assert.deepEqual(actionStep('click:text/播放!').target, { by: 'text', text: '播放', exact: true });
  assert.deepEqual(actionStep('click:role/button/搜索!').target, { by: 'role', role: 'button', name: '搜索', exact: true });
  assert.deepEqual(actionStep('click:label/用户名!').target, { by: 'label', name: '用户名', exact: true });
  // 无人名时 "!" 不能残留在 role 里
  assert.deepEqual(actionStep('click:role/button!').target, { by: 'role', role: 'button' });
  // 不带 "!" 仍是模糊匹配（保持既有行为）
  assert.deepEqual(actionStep('click:text/播放').target, { by: 'text', text: '播放' });
});

test('简写：非法输入报错并指明原因', () => {
  assert.throws(() => actionStep('fly:css/.x'), /未知动作/);
  assert.throws(() => actionStep('click:xpath//a'), /未知定位器前缀/);
  assert.throws(() => actionStep('fill:css/.x'), /定位器>=<值/);
  assert.throws(() => actionStep('click:css/.x => bogus:1'), /未知 expect 类型/);
});

// ---------------------------------------------------------------------------
// 归一化：简写与对象混排、自动补 id、与既有校验协同
// ---------------------------------------------------------------------------

test('expandShorthandSteps：字符串与对象混排，缺 id 的自动补 sN', () => {
  const out = expandShorthandSteps([
    'screenshot',
    { kind: 'assert', expect: [{ kind: 'url_contains', value: 'x' }] } as never,
    'navigate:https://example.com => url_contains:example.com',
  ]);
  assert.deepEqual(out.map((s) => s.id), ['s1', 's2', 's3']);
  assert.equal(out[2]!.kind, 'action');
});

test('validateExecuteSteps：接受简写并返回可落库的 FlowStep[]', () => {
  const steps = validateExecuteSteps([
    'navigate:https://example.com => url_contains:example.com',
    'click:text/更多 => text_present:更多',
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.id, 's1');
  assert.equal(steps[1]!.id, 's2');
});

test('validateExecuteSteps：简写写操作缺后置条件照样拒绝（守住既有约束）', () => {
  assert.throws(() => validateExecuteSteps(['click:text/提交订单']), /缺少 expect 后置条件/);
  assert.throws(() => validateExecuteSteps(['navigate:https://example.com']), /缺少 expect 后置条件/);
});

test('validateExecuteSteps：只读动作无需后置条件', () => {
  assert.doesNotThrow(() => validateExecuteSteps(['screenshot', 'scroll:600']));
});
