import type { ExpectSpec, LocatorSpec } from './types.js';
import { err } from './errors.js';
import type { LocatorPort, PagePort } from './ports.js';

/** 白名单定位器映射（DESIGN §8.1）：优先 role/label/testId，css 为显式备用。 */
export function resolveLocator(page: PagePort, spec: LocatorSpec): LocatorPort {
  switch (spec.by) {
    case 'role':
      return page.locator(spec);
    case 'label':
      return page.locator(spec);
    case 'testId':
      return page.locator(spec);
    case 'text':
      return page.locator(spec);
    case 'css':
      return page.locator(spec);
    default: {
      const never: never = spec;
      throw err('INVALID_INPUT', `未知定位器: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * 证据/报错里的 URL 收敛：超长（活动追踪参数可达数百字符）时只留 origin+path。
 * 一次多步任务里同一个 URL 会重复出现在每步证据与失败原因中，收敛后省下大量无关字符。
 */
export function evidenceUrl(url: string): string {
  if (url.length <= 120) return url;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

export interface ExpectContext {
  vars: Record<string, unknown>;
  lastDownload?: { artifactId?: string };
  /** 页面状态类断言的重试窗口（毫秒）；0/缺省见 verifyExpects。 */
  retryMs?: number;
}

/** 点路径取变量：'items.count' → vars['items']?.count；不存在的路径返回 undefined。 */
export function resolveVarPath(vars: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return vars[path];
  let cur: unknown = vars;
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 页面类断言的重试窗口（毫秒）与轮询间隔。 */
const DEFAULT_RETRY_MS = 5_000;
const RETRY_POLL_MS = 100;
/** 只有「页面状态类」断言重试有意义；var_equals / download_completed 是任务内事实，重试只会白等。 */
const RETRYING_KINDS = new Set(['url_contains', 'text_present', 'not_visible', 'count_gte', 'value_equals', 'value_contains']);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 单次判定（失败不抛错，由调用方决定是否重试）。 */
interface Verdict { ok: boolean; reason?: string }

/**
 * 后置条件验证（代码可计算事实优先，DESIGN §6.1）。失败不抛错，返回清单。
 *
 * 页面状态类断言默认在 ctx.retryMs 窗口内轮询重试：SPA 的路由切换、接口回包、框架重渲染
 * 都有百毫秒级延迟，单发判定会把「慢」误判成「失败」。窗口 0 = 退回单发（测试用）。
 * visible/hidden 自身就是轮询断言，不叠加外层重试。
 */
export async function verifyExpects(
  page: PagePort,
  expects: ExpectSpec[],
  ctx: ExpectContext,
  timeoutMs: number,
): Promise<{ ok: boolean; failures: Array<{ kind: string; reason: string }> }> {
  const retryBudget = Math.max(0, Math.min(ctx.retryMs ?? DEFAULT_RETRY_MS, timeoutMs));
  const failures: Array<{ kind: string; reason: string }> = [];

  const checkOnce = async (e: ExpectSpec): Promise<Verdict> => {
    switch (e.kind) {
      case 'url_contains': {
        if (!page.url().includes(String(e.value ?? ''))) {
          return { ok: false, reason: `当前 URL ${evidenceUrl(page.url())} 不含 "${e.value}"` };
        }
        return { ok: true };
      }
      case 'text_present': {
        const needle = JSON.stringify(e.value ?? '');
        const found = await page.evaluate(`(document.body && document.body.innerText || '').includes(${needle})`);
        return found ? { ok: true } : { ok: false, reason: `页面文本不含 "${e.value}"` };
      }
      case 'visible': {
        if (!e.target) throw err('INVALID_INPUT', 'visible 断言需要 target');
        await resolveLocator(page, e.target).first().waitFor('visible', { timeout: timeoutMs });
        return { ok: true };
      }
      case 'hidden': {
        if (!e.target) throw err('INVALID_INPUT', 'hidden 断言需要 target');
        await resolveLocator(page, e.target).first().waitFor('hidden', { timeout: timeoutMs });
        return { ok: true };
      }
      case 'not_visible': {
        // 「元素已消失」：验证删除/关闭类操作已生效。
        if (!e.target) throw err('INVALID_INPUT', 'not_visible 断言需要 target');
        const visible = await resolveLocator(page, e.target).first().isVisible();
        return visible ? { ok: false, reason: `目标仍然可见: ${JSON.stringify(e.target)}` } : { ok: true };
      }
      case 'value_equals':
      case 'value_contains': {
        // 表单值断言：fill/select 唯一可用的真后置条件（受控组件静默失败时能抓住）。
        if (!e.target) throw err('INVALID_INPUT', `${e.kind} 断言需要 target`);
        const actual = await resolveLocator(page, e.target).first().inputValue({ timeout: timeoutMs });
        const want = String(e.value ?? '');
        if (e.kind === 'value_equals' && actual !== want) {
          return { ok: false, reason: `输入值 ${JSON.stringify(actual)} ≠ ${JSON.stringify(want)}` };
        }
        if (e.kind === 'value_contains' && !actual.includes(want)) {
          return { ok: false, reason: `输入值 ${JSON.stringify(actual)} 不含 ${JSON.stringify(want)}` };
        }
        return { ok: true };
      }
      case 'count_gte': {
        if (!e.target) throw err('INVALID_INPUT', 'count_gte 断言需要 target');
        const n = await resolveLocator(page, e.target).count();
        return n >= Number(e.value ?? 1) ? { ok: true } : { ok: false, reason: `命中 ${n} 个 < 期望 ${e.value}` };
      }
      case 'download_completed': {
        if (!ctx.lastDownload?.artifactId) return { ok: false, reason: '动作未产生受管 artifact' };
        if (e.variable) ctx.vars[e.variable] = ctx.lastDownload.artifactId;
        return { ok: true };
      }
      case 'var_equals': {
        const actual = e.variable ? resolveVarPath(ctx.vars, e.variable) : undefined;
        return actual === e.value
          ? { ok: true }
          : { ok: false, reason: `变量 ${e.variable} = ${JSON.stringify(actual)} ≠ ${JSON.stringify(e.value)}` };
      }
      default:
        return { ok: false, reason: '未知断言类型' };
    }
  };

  for (const e of expects) {
    const retry = retryBudget > 0 && RETRYING_KINDS.has(e.kind);
    const deadline = Date.now() + retryBudget;
    try {
      let v = await checkOnce(e);
      while (!v.ok && retry && Date.now() < deadline) {
        await sleep(RETRY_POLL_MS);
        v = await checkOnce(e);
      }
      if (!v.ok) failures.push({ kind: e.kind, reason: v.reason ?? '未满足' });
    } catch (e2) {
      failures.push({ kind: e.kind, reason: (e2 as Error).message.slice(0, 200) });
    }
  }
  return { ok: failures.length === 0, failures };
}

