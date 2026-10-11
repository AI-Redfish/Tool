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
  /** 是否与视口相交。goal 循环据此优先把「眼前能点的」交给 Jev；不外发（对外载荷剥掉）。 */
  inViewport?: boolean;
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

/** 瘦身版观察（仅用于对外序列化，不影响 goal/judge 的内部候选）：
 *  1) 剥离与 name 恒等的 text 字段（当前观察脚本里两者同源）；
 *  2) 剥掉「同名标题」——搜索/列表页每张卡片都是 `<a>标题</a>` + `<h3>同名标题</h3>`，
 *     非 heading 已给出同样的名字时，heading 是纯重复。 */
export function slimObservation(obs: PageObservation): PageObservation {
  const named = new Set<string>();
  const elements: ObservedElement[] = [];
  for (const e of obs.elements) {
    if (e.role === 'heading' && named.has(e.name)) continue;
    if (e.role !== 'heading') named.add(e.name);
    if (e.text === undefined || e.text === e.name) {
      // inViewport 也是内部信息（对外默认已按视口过滤，保留它只是白占体积）
      const { text: _drop, inViewport: _drop2, ...rest } = e;
      elements.push(rest as ObservedElement);
    } else {
      elements.push(e);
    }
  }
  return { ...obs, elements, counts: { total: elements.length } };
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

const SNAPSHOT_SCRIPT = (
  viewportOnly: boolean,
  maxElements: number,
  filter: string,
  roles: string[],
) => `
(() => {
  const MAX = ${maxElements};
  const VIEWPORT_ONLY = ${viewportOnly};
  const FILTER = ${JSON.stringify(filter.toLowerCase())};
  const ROLES = ${JSON.stringify(roles)};
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
    if (ROLES.length > 0 && !ROLES.includes(role)) continue;
    if (FILTER && !name.toLowerCase().includes(FILTER)) continue;
    // text 与 name 同源：保留在内部对象里（goal/judge 的候选去重依赖它），
    // 但序列化给外部（CLI/MCP/API）时会由 slimObservation 剥掉，避免同一串字符传两遍。
    const item = { i: i++, role, name, tag: el.tagName.toLowerCase(), text: name.slice(0, 160) };
    if (inViewport(box)) item.inViewport = true;
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
  /** 只保留 name 含该子串的元素（大小写不敏感）。用于「找我要的那个东西」而非整页。 */
  filter?: string;
  /** 只保留这些 role 的元素（如 ['button','textbox']）。 */
  roles?: string[];
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
    raw = await page.evaluate(
      SNAPSHOT_SCRIPT(opts.viewportOnly === true, max, opts.filter ?? '', opts.roles ?? []),
    ) as { elements: ObservedElement[]; truncated: boolean };
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
        // 后台标签页里 requestAnimationFrame 不触发，只靠它会让 settle 一直挂到超时；
        // 用定时器兜底（取先到者）。
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(true); } };
        requestAnimationFrame(() => requestAnimationFrame(done));
        // 定时器兜底：后台标签页 rAF 不触发，只能靠它。实测它在「后台 + 每轮 goal」的路径上
        // 是每轮的主要固定开销（goal 单轮 ~600ms 里它占 ~200ms）。120ms 仍有 ~7 帧余量。
        setTimeout(done, 120);
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
