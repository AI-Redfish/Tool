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
  text: string;
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
}

const SNAPSHOT_SCRIPT = `
(() => {
  const MAX = 400;
  const sel = 'a[href], button, input, select, textarea, [role], label, summary, option';
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
    return tag;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
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
    if (!visible(el)) continue;
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
    const role = roleOf(el);
    const name = nameOf(el).slice(0, 120);
    const text = role === 'link' || role === 'button' || role === 'option' ? name : name;
    if (!name && !text) continue;
    const item = { i: i++, role, name, tag: el.tagName.toLowerCase(), text: text.slice(0, 160) };
    if (el.disabled) item.disabled = true;
    if (role === 'checkbox' || role === 'radio') item.checked = Boolean(el.checked);
    if ((role === 'textbox') && el.value) item.hasValue = true;
    out.push(item);
  }
  return { elements: out, truncated: false };
})()
`;

/** 采集前先做 origin 授权检查：未授权页禁止读取与外发（DESIGN §10）。 */
export async function observePage(
  page: PagePort,
  opts: { allowedOrigins: string[] },
): Promise<PageObservation> {
  assertOriginAllowed(page.url(), opts.allowedOrigins);
  let raw: { elements: ObservedElement[]; truncated: boolean };
  try {
    raw = await page.evaluate(SNAPSHOT_SCRIPT) as { elements: ObservedElement[]; truncated: boolean };
  } catch (e) {
    throw err('CAPABILITY_UNSUPPORTED', `页面观察失败（frame/导航中?）: ${(e as Error).message.slice(0, 120)}`);
  }
  let title = '';
  try {
    title = await page.title();
  } catch {
    title = '';
  }
  return {
    snapshotId: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    url: page.url(),
    title,
    elements: raw.elements,
    counts: { total: raw.elements.length },
    truncated: raw.truncated,
  };
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
