import { err } from './errors.js';
import type { ActionStep, ExpectSpec, FlowStep, GoalStep, LocatorSpec } from './types.js';

/**
 * 紧凑步骤语法（可选）：把一条步骤压成一行字符串，省掉模型生成整段 JSON 的开销。
 *
 *   <verb>:<参数>[ => <expect>[; <expect>]...]
 *
 * 定位器（斜杠分隔，与 LocatorSpec 一一对应）：
 *   role/<role>[/<name>]   label/<name>   testid/<id>   text/<text>   css/<selector>
 *
 * expect（冒号分隔 kind 与参数）：
 *   url_contains:<s>      text_present:<s>    visible:<loc>    hidden:<loc>
 *   not_visible:<loc>     count_gte:<loc>=<n>
 *   value_equals:<loc>=<v>  value_contains:<loc>=<v>
 *   var_equals:<var>=<v>  download_completed
 *
 * 值分隔符是参数里**最后一个** `=`（CSS 选择器常含 `=`，如 `[type=password]`）。
 * 值写成 `$name` 表示引用 values（`fill:css/#pw=$pw` → valuesRef）。
 *
 * 例：
 *   'navigate:https://example.com => url_contains:example.com'
 *   'click:role/button/搜索 => url_contains:/search'
 *   'fill:css/input.nav-search-input=虎皮鹦鹉 => value_equals:css/input.nav-search-input=虎皮鹦鹉'
 *   'press:Enter'
 *   'wait:2000'
 */

const VERBS = new Set(['navigate', 'click', 'fill', 'press', 'select', 'scroll', 'wait', 'screenshot', 'upload', 'evaluate', 'goal']);

/** 末尾 "!" 表示精确匹配：text/播放! → { by:'text', text:'播放', exact:true }。
 *  列表页常有同名元素（标题链接、同名容器、hover 卡），非精确会点到不可点的容器上——
 *  实测踩过：B 站 UP 主名有 4 个同名节点，非精确点击落空。 */
function splitExact(raw: string): { value: string; exact: boolean } {
  return raw.endsWith('!') ? { value: raw.slice(0, -1), exact: true } : { value: raw, exact: false };
}

function parseLocator(raw: string, where: string): LocatorSpec {
  const i = raw.indexOf('/');
  if (i <= 0) {
    throw err('INVALID_INPUT', `${where}: 定位器写法应为 role/<role>[/<name>]、text/<文本>、css/<选择器> 等，收到 "${raw}"`);
  }
  const by = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (!rest) throw err('INVALID_INPUT', `${where}: 定位器 "${by}/" 缺少取值`);
  switch (by) {
    case 'role': {
      const j = rest.indexOf('/');
      if (j < 0) return { by: 'role', role: splitExact(rest).value }; // 无人名时也不能把 "!" 留在 role 里
      const rawName = rest.slice(j + 1);
      if (!rawName) return { by: 'role', role: rest.slice(0, j) };
      const { value: name, exact } = splitExact(rawName);
      return { by: 'role', role: rest.slice(0, j), name, ...(exact ? { exact: true } : {}) };
    }
    case 'label': {
      const { value: name, exact } = splitExact(rest);
      return { by: 'label', name, ...(exact ? { exact: true } : {}) };
    }
    case 'testid':
      return { by: 'testId', id: rest };
    case 'text': {
      const { value: text, exact } = splitExact(rest);
      return { by: 'text', text, ...(exact ? { exact: true } : {}) };
    }
    case 'css':
      return { by: 'css', selector: rest };
    default:
      throw err('INVALID_INPUT', `${where}: 未知定位器前缀 "${by}"（可用 role/label/testid/text/css）`);
  }
}

/** 把 `loc=value` 拆开：按最后一个 `=`，避免 CSS 选择器里的等号被误切。 */
function splitValue(raw: string, where: string): { loc: string; value: string } {
  const i = raw.lastIndexOf('=');
  if (i <= 0) throw err('INVALID_INPUT', `${where}: 需要 "<定位器>=<值>" 形式，收到 "${raw}"`);
  return { loc: raw.slice(0, i), value: raw.slice(i + 1) };
}

function parseExpect(raw: string): ExpectSpec {
  const i = raw.indexOf(':');
  const kind = (i < 0 ? raw : raw.slice(0, i)).trim();
  const arg = i < 0 ? '' : raw.slice(i + 1);
  const needArg = (): string => {
    if (!arg) throw err('INVALID_INPUT', `expect "${kind}" 缺少参数`);
    return arg;
  };
  switch (kind) {
    case 'url_contains':
    case 'text_present':
      return { kind, value: needArg() };
    case 'visible':
    case 'hidden':
    case 'not_visible':
      return { kind, target: parseLocator(needArg(), `expect ${kind}`) };
    case 'count_gte': {
      const { loc, value } = splitValue(needArg(), `expect ${kind}`);
      return { kind, target: parseLocator(loc, `expect ${kind}`), value: Number(value) };
    }
    case 'value_equals':
    case 'value_contains': {
      const { loc, value } = splitValue(needArg(), `expect ${kind}`);
      return { kind, target: parseLocator(loc, `expect ${kind}`), value };
    }
    case 'var_equals': {
      const { loc, value } = splitValue(needArg(), `expect ${kind}`);
      return { kind, variable: loc, value };
    }
    case 'download_completed':
      return { kind };
    default:
      throw err('INVALID_INPUT', `未知 expect 类型 "${kind}"`);
  }
}

/** 简写解析产物：action 步骤去掉 id（由 expandShorthandSteps 统一补齐）。 */
export type ShorthandStep = Omit<ActionStep, 'id'> | Omit<GoalStep, 'id'>;

/** 解析单条简写为 action 步骤（id 由调用方补齐）。 */
export function parseShorthandStep(input: string): ShorthandStep {
  const raw = input.trim();
  if (!raw) throw err('INVALID_INPUT', '步骤简写不能为空');
  // evaluate 的参数是自由 JS，里面几乎必然出现 "=>"（箭头函数），不能按它切分后置条件；
  // 需要给 evaluate 加后置条件时请用对象形式写步骤。
  const isEvaluate = /^evaluate\s*:/.test(raw);
  const arrow = isEvaluate ? -1 : raw.indexOf('=>');
  const head = (arrow < 0 ? raw : raw.slice(0, arrow)).trim();
  const expectPart = arrow < 0 ? '' : raw.slice(arrow + 2);
  const expects: ExpectSpec[] = expectPart
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseExpect);

  const colon = head.indexOf(':');
  const verb = (colon < 0 ? head : head.slice(0, colon)).trim();
  const arg = colon < 0 ? '' : head.slice(colon + 1).trim();
  const needArg = (): string => {
    if (!arg) throw err('INVALID_INPUT', `步骤 "${verb}" 缺少参数`);
    return arg;
  };
  if (!VERBS.has(verb)) {
    throw err('INVALID_INPUT', `未知动作 "${verb}"（可用 ${[...VERBS].join('/')}）`);
  }
  const base = { kind: 'action' as const, expect: expects };
  switch (verb) {
    case 'navigate':
      return { ...base, action: 'navigate', value: needArg() };
    case 'click':
      return { ...base, action: 'click', target: parseLocator(needArg(), verb) };
    case 'fill':
    case 'select':
    case 'upload': {
      const { loc, value } = splitValue(needArg(), verb);
      const target = parseLocator(loc, verb);
      if (verb === 'upload') return { ...base, action: 'upload', target, filePath: value };
      return value.startsWith('$')
        ? { ...base, action: verb, target, valuesRef: value.slice(1) }
        : { ...base, action: verb, target, value };
    }
    case 'press':
      return { ...base, action: 'press', key: needArg() };
    case 'scroll':
      return { ...base, action: 'scroll', value: Number(needArg()) };
    case 'wait': {
      const a = needArg();
      return Number.isFinite(Number(a))
        ? { ...base, action: 'wait', value: Number(a) }
        : { ...base, action: 'wait', target: parseLocator(a, verb) };
    }
    case 'evaluate':
      return { ...base, action: 'evaluate', script: needArg() };
    case 'goal':
      // Jev 局部语义循环：本页上「点哪/填哪」交给 Jev 自己判断，大模型不必先看一遍页面。
      // 需要该页 origin ∈ modelOrigins（页面候选会发给 Jev 服务）。
      return { kind: 'goal', goal: needArg(), expect: expects };
    default:
      // screenshot
      return { ...base, action: 'screenshot' };
  }
}

/**
 * 归一化步骤数组：展开字符串简写、给缺 id 的步骤补 id。
 * 返回新的数组（不修改入参），供校验与落库统一使用。
 */
export function expandShorthandSteps(input: readonly (FlowStep | string)[]): FlowStep[] {
  const out: FlowStep[] = [];
  let n = 0;
  for (const item of input) {
    n += 1;
    if (typeof item === 'string') {
      out.push({ ...parseShorthandStep(item), id: `s${n}` } as FlowStep);
    } else {
      out.push(item.id ? item : { ...item, id: `s${n}` });
    }
  }
  return out;
}
