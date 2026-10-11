import { err } from './errors.js';
import type { ExpectSpec, FlowStep, LocatorSpec } from './types.js';

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

const VERBS = new Set(['navigate', 'click', 'fill', 'press', 'select', 'scroll', 'wait', 'screenshot', 'upload', 'evaluate']);

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
      if (j < 0) return { by: 'role', role: rest };
      const name = rest.slice(j + 1);
      return name ? { by: 'role', role: rest.slice(0, j), name } : { by: 'role', role: rest.slice(0, j) };
    }
    case 'label':
      return { by: 'label', name: rest };
    case 'testid':
      return { by: 'testId', id: rest };
    case 'text':
      return { by: 'text', text: rest };
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

/** 解析单条简写为 FlowStep（id 由调用方补齐）。 */
export function parseShorthandStep(input: string): Omit<FlowStep, 'id'> & { id?: string } {
  const raw = input.trim();
  if (!raw) throw err('INVALID_INPUT', '步骤简写不能为空');
  const arrow = raw.indexOf('=>');
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
      const parsed = parseShorthandStep(item) as FlowStep;
      out.push({ ...parsed, id: parsed.id ?? `s${n}` });
    } else {
      out.push(item.id ? item : { ...item, id: `s${n}` });
    }
  }
  return out;
}
