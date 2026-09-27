import type { LocatorSpec, PageCandidate } from './types.js';

/**
 * 浏览器端口（DESIGN §2/§3）：core 只依赖这些结构接口，不 import playwright。
 * connectors.ts 提供真实实现；tests/fakes.ts 提供离线假件。
 * 结构与 Playwright 对应面保持一致，connectors 用边界适配（cast）接入。
 */

export interface DialogPort {
  type(): string;
  message(): string;
  accept(text?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export interface DownloadPort {
  saveAs(path: string): Promise<void>;
  failure(): Promise<string | null>;
  suggestedFilename(): string;
}

export interface LocatorPort {
  count(): Promise<number>;
  first(): LocatorPort;
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  press(key: string, opts?: { timeout?: number }): Promise<void>;
  selectOption(value: string, opts?: { timeout?: number }): Promise<void>;
  /** 上传本地文件到 file input（DESIGN §10；路径安全检查由调用方完成）。 */
  setInputFiles(files: string[], opts?: { timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
  innerText(opts?: { timeout?: number }): Promise<string>;
  waitFor(state: 'visible' | 'hidden' | 'attached', opts?: { timeout?: number }): Promise<void>;
}

export interface PagePort {
  url(): string;
  /** 页面是否已关闭（人工关页/导航崩溃后，候选失效，DESIGN §4.3）。 */
  isClosed(): boolean;
  title(): Promise<string>;
  goto(url: string, opts?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown>;
  locator(spec: LocatorSpec): LocatorPort;
  evaluate<T = unknown>(script: string): Promise<T>;
  keyboardPress(key: string, opts?: { timeout?: number }): Promise<void>;
  mouseWheel(dx: number, dy: number): Promise<void>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  waitForTimeout(ms: number): Promise<void>;
  waitForDownload(opts?: { timeout?: number }): Promise<DownloadPort>;
  onDialog(handler: (dialog: DialogPort) => void): void;
  setContentForTest?(html: string): Promise<void>; // 仅供测试假件/夹具
}

export interface ContextPort {
  pages(): PagePort[];
  /** 返回给定端口对象在页面列表中的下标；找不到返回 -1。
   *  注意 pages() 可能每次返回新包装实例，必须用底层同一性比较（adapter 实现）。 */
  indexOfPage(page: PagePort): number;
  newPage(url?: string): Promise<PagePort>;
  onPage(handler: (page: PagePort) => void): void;
}

export interface BrowserPort {
  contexts(): ContextPort[];
  /** detach：attach 时只应断开连接（P0 验证项，DESIGN §4.3）；launch 时关闭实例。 */
  close(): Promise<void>;
}

export interface ConnectResult {
  browser: BrowserPort;
  ownership: 'borrowed' | 'owned';
  /** attach 借用；launch 拥有并可安全关闭。 */
  kind: 'attach' | 'launch';
}

export interface BrowserConnector {
  connect(): Promise<ConnectResult>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Logger {
  /** 全部日志走 stderr（stdio 协议约束，DESIGN/仓库规范）。 */
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

export function consoleLogger(): Logger {
  return {
    warn: (m) => console.error(`[jev-browser][warn] ${m}`),
    info: (m) => console.error(`[jev-browser][info] ${m}`),
    debug: (m) => console.error(`[jev-browser][debug] ${m}`),
  };
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** 脱敏页面元数据：origin + 路径，去掉 query/fragment（DESIGN §10）。 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparsable)';
  }
}

export function toCandidate(pageId: string, page: PagePort, title: string): PageCandidate {
  return { pageId, title: title.slice(0, 80), url: redactUrl(page.url()) };
}
