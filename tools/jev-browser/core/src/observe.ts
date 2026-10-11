import { err } from './errors.js';
import { assertOriginAllowed } from './policy.js';
import type { PagePort } from './ports.js';

/**
 * 页面观察（DESIGN §6.2）：只读枚举交互元素，密码/Cookie/token 不进入 state。
 * 脚本为内置固定实现，不向调用方暴露任意 evaluate。
 */

export interface ObservedElement {
  i: number;
  role: string;
  name: string;
  tag: string;
  /** 文本标签，与 name 同源；外部序列化时会被剥离（见 slimObservation）。 */
  text?: string;
  disabled?: boolean;
  checked?: boolean;
  /** 文本输入的已有值会被遮蔽为固定标记，不外发真实内容。 */
  hasValue?: boolean;
}

export interface PageObservation {
  /** 快照内稳定标识（DESIGN §6.2：候选 ID 仅在该快照有效）。 */
  snapshotId: string;
  url: string;
  title: string;
  elements: ObservedElement[];
  counts: { total: number };
  truncated: boolean;
  /** forModel 紧凑渲染：一行一个元素，供模型直接阅读（比对象数组小一个量级）。 */
  rendered?: string[];
}

/** 元素上限默认值与硬上限（防单次快照把上下文打满）。 */
export const MAX_ELEMENTS_DEFAULT = 400;
export const MAX_ELEMENTS_CAP = 2000;

/** 瘦身版观察：剥离与 name 恒等的 text 字段（当前观察脚本里两者同源），其余原样。 */
export function slimObservation(obs: PageObservation): PageObservation {
  return {
    ...obs,
    elements: obs.elements.map((e) => {
      if (e.text === undefined || e.text === e.name) {
        const { text: _drop, ...rest } = e;
        return rest as ObservedElement;
      }
      return e;
    }),
  };
}

/** forModel 紧凑渲染：[i] role "name" [标记]。 */
export function renderObservation(obs: PageObservation): string[] {
  const lines = obs.elements.map((e) => {
    const marks: string[] = [];
    if (e.disabled) marks.push('disabled');
    if (e.checked !== undefined) marks.push(e.checked ? 'checked' : 'unchecked');
    if (e.hasValue) marks.push('hasValue');
    return `[${e.i}] ${e.role} "${e.name}"${marks.length > 0 ? ` [${marks.join(',')}]` : ''}`;
  });
  lines.push(`# 共 ${obs.elements.length} 个元素${obs.truncated ? '（已截断）' : ''}`);
  return lines;
}

const SNAPSHOT_SCRIPT = (viewportOnly: boolean, maxElements: number) => `
(() => {
  const MAX = ${maxElements};
  const VIEWPORT_ONLY = ${viewportOnly};
  // h1–h6 有隐式 ARIA 角色 heading（DESIGN §6.2：按 role/name 枚举交互元素）
  const sel = 'a[href], button, input, select, textarea, [role], label, summary, option, h1, h2, h3, h4, h5, h6';
  const nodes = Array.from(document.querySelectorAll(sel));
  const out = [];
  const roleOf = (el) => {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'file') return 'file';
      return 'textbox';
    }
    if (tag === 'option') return 'option';
    if (tag === 'label') return 'label';
    if (tag === 'summary') return 'summary';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  };
  const boxOf = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 || r.height > 0)) return null;
    return r;
  };
  const inViewport = (r) => {
    const vh = window.innerHeight || 0;
    const vw = window.innerWidth || 0;
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  };
  const nameOf = (el) => {
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const lab = document.getElementById(labelledby);
      if (lab) return (lab.innerText || '').trim();
    }
    const label = el.getAttribute && el.getAttribute('aria-label');
    if (label) return label.trim();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const id = el.id;
      if (id) {
        const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return (lab.innerText || '').trim();
      }
      const ph = el.getAttribute('placeholder');
      if (ph) return ph.trim();
      return (el.getAttribute('name') || '').trim();
    }
    return (el.innerText || el.textContent || el.getAttribute('value') || '').trim().replace(/\\s+/g, ' ');
  };
  let i = 0;
  for (const el of nodes) {
    if (out.length >= MAX) return { elements: out, truncated: true };
    const box = boxOf(el);
    if (box === null) continue;
    if (VIEWPORT_ONLY && !inViewport(box)) continue;
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
    const role = roleOf(el);
    const name = nameOf(el).slice(0, 120);
    if (!name) continue;
    // text 与 name 同源：保留在内部对象里（goal/judge 的候选去重依赖它），
    // 但序列化给外部（CLI/MCP/API）时会由 slimObservation 剥掉，避免同一串字符传两遍。
    const item = { i: i++, role, name, tag: el.tagName.toLowerCase(), text: name.slice(0, 160) };
    if (el.disabled) item.disabled = true;
    if (role === 'checkbox' || role === 'radio') item.checked = Boolean(el.checked);
    if ((role === 'textbox') && el.value) item.hasValue = true;
    out.push(item);
  }
  return { elements: out, truncated: false };
})()
`;

/** 采集前先做 origin 授权检查：未授权页禁止读取与外发（DESIGN §10）。 */
export interface ObserveOptions {
  allowedOrigins: string[];
  /** 只采集与视口相交的元素（默认 false = 整页）。页脚/长列表场景可显著减小载荷。 */
  viewportOnly?: boolean;
  /** 元素上限（默认 400，硬上限 2000）。 */
  maxElements?: number;
  /** true = 额外产出 rendered 紧凑文本，供模型直接阅读。 */
  forModel?: boolean;
}

export async function observePage(
  page: PagePort,
  opts: ObserveOptions,
): Promise<PageObservation> {
  assertOriginAllowed(page.url(), opts.allowedOrigins);
  const raw0 = Number(opts.maxElements ?? MAX_ELEMENTS_DEFAULT);
  const max = Math.max(1, Math.min(Number.isFinite(raw0) ? raw0 : MAX_ELEMENTS_DEFAULT, MAX_ELEMENTS_CAP));
  let raw: { elements: ObservedElement[]; truncated: boolean };
  try {
    raw = await page.evaluate(SNAPSHOT_SCRIPT(opts.viewportOnly === true, max)) as { elements: ObservedElement[]; truncated: boolean };
  } catch (e) {
    throw err('CAPABILITY_UNSUPPORTED', `页面观察失败（frame/导航中?）: ${(e as Error).message.slice(0, 120)}`);
  }
  let title = '';
  try {
    title = await page.title();
  } catch {
    title = '';
  }
  const obs: PageObservation = {
    snapshotId: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    url: page.url(),
    title,
    elements: raw.elements,
    counts: { total: raw.elements.length },
    truncated: raw.truncated,
  };
  if (opts.forModel) obs.rendered = renderObservation(obs);
  return obs;
}

export interface PageDiff {
  urlChanged: boolean;
  elementsAdded: number;
  elementsRemoved: number;
}

/** 轻量差量：用于循环检测与“页面无变化”判断（不追求精确 diff）。 */
export function diffObservation(prev: PageObservation | undefined, cur: PageObservation): PageDiff {
  if (!prev) return { urlChanged: true, elementsAdded: cur.elements.length, elementsRemoved: 0 };
  const sig = (o: PageObservation) => o.elements.map((e) => `${e.role}|${e.name}`).join('\n');
  const prevSet = new Set(prev.elements.map((e) => `${e.role}|${e.name}`));
  const curSet = new Set(cur.elements.map((e) => `${e.role}|${e.name}`));
  let added = 0;
  for (const s of curSet) if (!prevSet.has(s)) added++;
  let removed = 0;
  for (const s of prevSet) if (!curSet.has(s)) removed++;
  return { urlChanged: prev.url !== cur.url, elementsAdded: added, elementsRemoved: removed };
}

/** 简易 settle：readyState complete + 双 rAF，带上限；不用固定 sleep 也不等 networkidle（DESIGN §6.4）。 */
export async function waitForSettle(page: PagePort, timeoutMs: number): Promise<void> {
  const script = `new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (document.readyState === 'complete') {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        return;
      }
      if (Date.now() - start > ${Math.min(timeoutMs, 8000)}) { resolve(false); return; }
      setTimeout(tick, 100);
    };
    tick();
  })`;
  try {
    await page.evaluate(script);
  } catch {
    // 导航中 evaluate 可能抛错：忽略，由调用方重新观察。
  }
}
