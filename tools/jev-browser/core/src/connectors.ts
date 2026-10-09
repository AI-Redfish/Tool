import { chromium, type Browser as PwBrowser, type BrowserContext as PwContext, type Dialog as PwDialog, type Download as PwDownload, type Locator as PwLocator, type Page as PwPage } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JevBrowserConfig } from './config.js';
import {
  autoLaunchDebugChromeEnabled,
  DEFAULT_CHROME_DEBUG_PORT,
  ensureDebugChromeAt,
  prepareChromeDebug,
  probeCdp,
} from './chromedebug.js';
import { err } from './errors.js';
import type { BrowserConnector, BrowserPort, ConnectResult, ContextPort, DialogPort, DownloadPort, LocatorPort, PagePort } from './ports.js';
import { redactUrl } from './ports.js';
import type { LocatorSpec } from './types.js';

/**
 * Playwright 连接器与端口适配层（DESIGN §4）。
 *
 * 边界适配：core 其余部分只依赖 ports.ts 的结构接口；这里是唯一出现
 * playwright 类型的地方。生命周期约束：
 *  - attach：借用日常 Chrome。绝不 newContext、绝不 close 借用 context；
 *    browser.close() 仅断开 CDP 连接（是否保留浏览器进程/页面是 P0 端到端
 *    复核项，DESIGN §4.3 [S5]，不依据方法名断言）。
 *  - launch：工具拥有的实例，每个 engine 独立 profile 目录，可以安全关闭。
 */

// ---------------------------------------------------------------------------
// Playwright → 端口适配器（无状态薄包装）
// ---------------------------------------------------------------------------

class PwLocatorAdapter implements LocatorPort {
  constructor(private readonly loc: PwLocator) {}

  count(): Promise<number> {
    return this.loc.count();
  }

  first(): LocatorPort {
    return new PwLocatorAdapter(this.loc.first());
  }

  click(opts?: { timeout?: number }): Promise<void> {
    return this.loc.click(opts);
  }

  fill(value: string, opts?: { timeout?: number }): Promise<void> {
    return this.loc.fill(value, opts);
  }

  press(key: string, opts?: { timeout?: number }): Promise<void> {
    return this.loc.press(key, opts);
  }

  selectOption(value: string, opts?: { timeout?: number }): Promise<void> {
    // Playwright 返回选中的值数组；端口语义只要成功/失败
    return this.loc.selectOption(value, opts).then(() => undefined);
  }

  setInputFiles(files: string[], opts?: { timeout?: number }): Promise<void> {
    return this.loc.setInputFiles(files, opts);
  }

  isVisible(): Promise<boolean> {
    return this.loc.isVisible();
  }

  innerText(opts?: { timeout?: number }): Promise<string> {
    return this.loc.innerText(opts);
  }

  waitFor(state: 'visible' | 'hidden' | 'attached', opts?: { timeout?: number }): Promise<void> {
    // Playwright 的 waitFor 是单 options 对象：{ state, timeout }
    return this.loc.waitFor({ state, timeout: opts?.timeout });
  }
}

class PwDialogAdapter implements DialogPort {
  constructor(private readonly d: PwDialog) {}

  type(): string {
    return this.d.type();
  }

  message(): string {
    return this.d.message();
  }

  accept(text?: string): Promise<void> {
    return this.d.accept(text);
  }

  dismiss(): Promise<void> {
    return this.d.dismiss();
  }
}

class PwDownloadAdapter implements DownloadPort {
  constructor(private readonly dl: PwDownload) {}

  saveAs(p: string): Promise<void> {
    return this.dl.saveAs(p);
  }

  failure(): Promise<string | null> {
    return this.dl.failure();
  }

  suggestedFilename(): string {
    return this.dl.suggestedFilename();
  }
}

export class PwPageAdapter implements PagePort {
  constructor(private readonly page: PwPage) {}

  url(): string {
    return this.page.url();
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  title(): Promise<string> {
    return this.page.title();
  }

  goto(url: string, opts?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown> {
    return this.page.goto(url, opts);
  }

  locator(spec: LocatorSpec): LocatorPort {
    return new PwLocatorAdapter(pwLocatorOf(this.page, spec));
  }

  evaluate<T = unknown>(script: string): Promise<T> {
    // Playwright 接受字符串表达式；观察脚本是内置固定实现（DESIGN §6.2）。
    return this.page.evaluate(script) as Promise<T>;
  }

  keyboardPress(key: string): Promise<void> {
    // keyboard.press 是即时操作，无 actionability timeout 可传
    return this.page.keyboard.press(key);
  }

  mouseWheel(dx: number, dy: number): Promise<void> {
    return this.page.mouse.wheel(dx, dy);
  }

  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer> {
    return this.page.screenshot(opts) as Promise<Buffer>;
  }

  waitForTimeout(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms);
  }

  waitForDownload(opts?: { timeout?: number }): Promise<DownloadPort> {
    // 先注册 download 事件等待再由调用方触发动作（DESIGN §10 下载正确性）
    return this.page.waitForEvent('download', opts).then((d) => new PwDownloadAdapter(d));
  }

  onDialog(handler: (dialog: DialogPort) => void): void {
    this.page.on('dialog', (d) => void handler(new PwDialogAdapter(d)));
  }

  /** 调试/doctor 用：返回原始 Page（本模块外不得使用其副作用方法）。 */
  raw(): PwPage {
    return this.page;
  }
}

class PwContextAdapter implements ContextPort {
  constructor(private readonly ctx: PwContext) {}

  pages(): PagePort[] {
    return this.ctx.pages().filter((p) => !p.isClosed()).map((p) => new PwPageAdapter(p));
  }

  indexOfPage(page: PagePort): number {
    // pages() 每次产生新包装实例，必须用底层 Playwright 对象同一性比较
    const raw = page instanceof PwPageAdapter ? page.raw() : null;
    if (!raw) return -1;
    return this.ctx.pages().findIndex((p) => p === raw);
  }

  async newPage(url?: string): Promise<PagePort> {
    // BrowserContext.newPage() 无 url 参数（与 Browser.newPage 不同）：建页后再导航
    const page = await this.ctx.newPage();
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    return new PwPageAdapter(page);
  }

  onPage(handler: (page: PagePort) => void): void {
    this.ctx.on('page', (p) => void handler(new PwPageAdapter(p)));
  }
}

class PwBrowserAdapter implements BrowserPort {
  constructor(private readonly browser: PwBrowser) {}

  contexts(): ContextPort[] {
    return this.browser.contexts().map((c) => new PwContextAdapter(c));
  }

  close(): Promise<void> {
    // attach：断开 CDP 连接；launch（persistent context 经 wrapper）：关闭实例。
    return this.browser.close();
  }
}

/** 白名单定位器映射（DESIGN §8.1）：优先 role/label/testId，css 为显式备用。 */
function pwLocatorOf(page: PwPage, spec: LocatorSpec): PwLocator {
  switch (spec.by) {
    case 'role':
      return page.getByRole(spec.role as never, { name: spec.name, exact: spec.exact ?? undefined });
    case 'label':
      return page.getByLabel(spec.name, { exact: spec.exact ?? undefined });
    case 'testId':
      return page.getByTestId(spec.id);
    case 'text':
      return page.getByText(spec.text, { exact: spec.exact ?? undefined });
    case 'css':
      return page.locator(spec.selector);
    default: {
      const never: never = spec;
      throw err('INVALID_INPUT', `未知定位器: ${JSON.stringify(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// attach 端点解析：'chrome' 哨兵 / 显式 loopback URL / DevToolsActivePort 发现
// ---------------------------------------------------------------------------

const LOOPBACK_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/**
 * 解析 attach 端点（DESIGN §4.1）：
 *  - 显式 http(s)/ws(s) URL：仅接受 loopback，禁止由页面/模型提供的地址；
 *  - 'chrome'（默认）：先尝试 Playwright channel 语义；失败后从默认用户数据
 *    目录的 DevToolsActivePort 文件构造 http://127.0.0.1:<port>（与 Playwright
 *    固定版本的 channel 发现思路一致，不 import 私有模块 [S5]）。
 *    未验证前该路径保持候选状态，由 P0 实测定案。
 */
export function resolveAttachEndpoint(endpoint: string): string {
  if (!endpoint || endpoint === 'chrome') return 'chrome';
  if (/^(https?|wss?):\/\//i.test(endpoint)) {
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw err('CONFIG_INVALID', `CDP endpoint 不是合法 URL: ${endpoint}`);
    }
    if (!LOOPBACK_RE.test(u.hostname)) {
      throw err('CONFIG_INVALID', `CDP endpoint 只允许 loopback（防远程接管，DESIGN §4.1）: ${u.hostname}`);
    }
    return endpoint; // Playwright 接受 http(s) 调试端点
  }
  throw err('CONFIG_INVALID', `browser.attach.endpoint 只支持 "chrome" 或 loopback URL: ${endpoint}`);
}

/** 常见平台的 Chrome 默认用户数据目录（仅读取 DevToolsActivePort，不读浏览历史）。 */
function chromeUserDataDirs(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const base = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
      return [path.join(base, 'Google', 'Chrome', 'User Data')];
    }
    case 'darwin':
      return [path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')];
    default:
      return [
        path.join(home, '.config', 'google-chrome'),
        path.join(home, '.config', 'google-chrome-beta'),
      ];
  }
}

/** 从 DevToolsActivePort 文件读取本机回环端口；找不到/不可读返回 undefined。 */
export function discoverChromeLoopbackEndpoint(): string | undefined {
  for (const dir of chromeUserDataDirs()) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8');
      const port = Number(raw.split(/\r?\n/)[0]?.trim());
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      // 下一个候选目录
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 连接器
// ---------------------------------------------------------------------------

export class PlaywrightConnector implements BrowserConnector {
  constructor(private readonly cfg: JevBrowserConfig) {}

  async connect(): Promise<ConnectResult> {
    const b = this.cfg.browser;
    if (b.mode === 'attach') {
      const requested = resolveAttachEndpoint(b.attach.endpoint);
      const failures: string[] = [];

      // 固定端口自动确保（默认开启，JEV_BROWSER_AUTO_LAUNCH_DEBUG=false 关闭）
      //  - 显式 loopback 端点：连接前探测，无则自动以该端口启动调试 Chrome，有则复用；
      //  - 'chrome' 哨兵：9223 已有调试 Chrome 则优先复用（快路径，免去 60s 授权等待）。
      const fixedEndpoint = `http://127.0.0.1:${DEFAULT_CHROME_DEBUG_PORT}`;
      const reuseFixed = requested === 'chrome'
        ? autoLaunchDebugChromeEnabled() && (await probeCdp(DEFAULT_CHROME_DEBUG_PORT)).up
        : false;
      if (requested !== 'chrome' && autoLaunchDebugChromeEnabled()) {
        await ensureDebugChromeAt(requested, { waitMs: b.attach.timeoutMs, failures });
      }

      const attempts = requested === 'chrome'
        ? [...(reuseFixed ? [fixedEndpoint] : []), 'chrome', discoverChromeLoopbackEndpoint() ?? undefined]
        : [requested];
      for (const endpoint of attempts) {
        if (!endpoint) continue;
        try {
          const browser = await this.connectAttachWithDeadline(endpoint, b);
          return { browser: new PwBrowserAdapter(browser), ownership: 'borrowed', kind: 'attach' };
        } catch (e) {
          failures.push(`${endpoint === 'chrome' ? 'chrome(channel)' : endpoint}: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
        }
      }

      // 'chrome' 哨兵全部失败且未复用成功 → 兜底：自动以固定端口 9223 启动调试 Chrome 再连
      //（端口被无 CDP 进程占用时快速失败，不擅自漂移端口——端点固定，以 JEV_BROWSER_CDP_ENDPOINT 为准）
      if (requested === 'chrome' && autoLaunchDebugChromeEnabled() && !reuseFixed) {
        try {
          const r = await prepareChromeDebug({ waitMs: b.attach.timeoutMs });
          const browser = await this.connectAttachWithDeadline(r.endpoint, b);
          return { browser: new PwBrowserAdapter(browser), ownership: 'borrowed', kind: 'attach' };
        } catch (e) {
          failures.push(`auto-launch(${fixedEndpoint}): ${(e as Error).message.split('\n')[0].slice(0, 200)}`);
        }
      }

      throw err('BROWSER_BUSY',
        `接管 Chrome 失败（需在 chrome://inspect/#remote-debugging 开启授权，Chrome ≥ 144，或提供已授权的 loopback endpoint）；各次尝试：${failures.join(' | ')}`,
        { details: { endpoint: requested, attempts: failures } });
    }

    // launch：本机 Chrome（channel）或 Playwright 管理的 Chromium；独立 profile 目录
    const userDataDir = b.launch.userDataDir ?? path.join(this.cfg.runtime.dataDir, 'profiles', b.engine, 'default');
    fs.mkdirSync(userDataDir, { recursive: true });
    try {
      const ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: b.headless,
        chromiumSandbox: b.launch.chromiumSandbox,
        timeout: b.launch.timeoutMs,
        channel: b.engine === 'chrome' ? 'chrome' : undefined,
      });
      const context = new PwContextAdapter(ctx);
      const wrapper: BrowserPort = {
        contexts: () => [context],
        close: () => ctx.close(),
      };
      return { browser: wrapper, ownership: 'owned', kind: 'launch' };
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0].slice(0, 200);
      if (/Executable doesn't exist/i.test(msg)) {
        throw err('CAPABILITY_UNSUPPORTED', 'Playwright 管理的 Chromium 未安装。在本工具 core 目录下执行: pnpm exec playwright install chromium（勿用裸 npx，可能命中系统里其他语言的 playwright）');
      }
      if (/ProcessSingleton|Failed to create|SingletonLock/i.test(msg)) {
        throw err('BROWSER_BUSY', `启动失败：profile 目录可能已被占用（另一个 Chrome 实例正在使用）: ${userDataDir}`);
      }
      throw err('BROWSER_BUSY', `启动浏览器失败: ${msg}`);
    }
  }

  /**
   * attach 硬截止：Chrome 144+ 授权模式下，WS 握手会等待用户在 Chrome 内点击
   * 「允许」授权弹窗，Playwright 自身的 timeout 不能中断该等待（否则永久卡住）。
   * 这里用 Promise.race 施加外层硬超时；超时后吞掉原 promise 迟到的 rejection
   * （no-op catch 分支不影响 race 本身），避免 unhandled rejection 崩溃进程。
   */
  private connectAttachWithDeadline(
    endpoint: string,
    b: JevBrowserConfig['browser'],
  ): ReturnType<typeof chromium.connectOverCDP> {
    const connecting = endpoint === 'chrome'
      ? chromium.connectOverCDP('chrome', { noDefaults: b.attach.noDefaults, timeout: b.attach.timeoutMs })
      : chromium.connectOverCDP(endpoint, { timeout: b.attach.timeoutMs });
    connecting.catch(() => undefined); // 硬超时后迟到失败的容错分支
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(err('BROWSER_BUSY',
          `attach ${endpoint === 'chrome' ? 'chrome(channel)' : endpoint} ${b.attach.timeoutMs}ms 内未完成连接——最常见原因：Chrome 正在等你点击连接授权弹窗（弹窗在 Chrome 窗口内，可能被其他窗口遮挡），或从未开启远程调试授权。` +
          `请：① 在 Chrome 地址栏打开 chrome://inspect/#remote-debugging 勾选 "Allow remote debugging"，重跑并在弹窗中点「允许」；` +
          `② 或先跑 cli chrome-debug：以固定调试端口 9223 启动/复用专用 Chrome 并自动配置 attach 端点（跨 Windows/macOS）；` +
          `③ 或改用 launch 模式（set JEV_BROWSER_MODE=launch）；④ 缩短本等待可用 set JEV_BROWSER_CONNECT_TIMEOUT_MS=<毫秒>`));
      }, b.attach.timeoutMs);
    });
    return Promise.race([connecting, deadline]).finally(() => clearTimeout(timer)) as ReturnType<typeof chromium.connectOverCDP>;
  }
}

// ---------------------------------------------------------------------------
// 页面选择
// ---------------------------------------------------------------------------

/** 会话页面选择（DESIGN §4.1/§8.1）：单页自动选定；多页不猜，返回候选。 */
export interface PageSelection {
  page: PagePort | null;
  candidates: Array<{ pageId: string; title: string; url: string }>;
}

export async function selectPage(context: ContextPort, pageId?: string): Promise<PageSelection> {
  const pages = context.pages();
  const candidates: PageSelection['candidates'] = [];
  for (let i = 0; i < pages.length; i++) {
    let title = '';
    try {
      title = await pages[i].title();
    } catch {
      title = '';
    }
    candidates.push({ pageId: `p${i}`, title: title.slice(0, 80), url: redactUrl(pages[i].url()) });
  }
  if (pageId !== undefined) {
    const idx = Number(pageId.replace(/^p/, ''));
    if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
      throw err('PAGE_NOT_RESOLVED', `pageId 不存在（标签页可能已被关闭，请重新 browser_pages）: ${pageId}`, { details: { candidates } });
    }
    return { page: pages[idx], candidates };
  }
  if (pages.length === 1) return { page: pages[0], candidates };
  return { page: null, candidates };
}

/**
 * Dialog 控制器（DESIGN §4.4，用户已放开对话框限制）：
 *  - 已接管页默认自动接受对话框（accept）并记录事件；
 *  - 未接管页不安装 handler（其行为属 Playwright/CDP 层，是 P0 非干扰验证项，
 *    不在代码里承诺）；
 *  - armOnce 保留兼容（仅用于附加原因记录），默认策略已为接受且不再一次性消费。
 */
export class DialogManager {
  private policies = new WeakMap<object, { accept: boolean; reason: string }>();
  private installed = new WeakSet<object>();

  install(page: PagePort, onEvent?: (info: { type: string; message: string; accepted: boolean }) => void): void {
    const key = page as unknown as object;
    if (this.installed.has(key)) return;
    this.installed.add(key);
    page.onDialog(async (dialog: DialogPort) => {
      const policy = this.policies.get(key) ?? { accept: true, reason: '已放开：默认自动接受对话框' };
      let accepted = false;
      try {
        if (policy.accept) {
          await dialog.accept();
          accepted = true;
        } else {
          await dialog.dismiss();
        }
      } catch {
        // 对话框可能已被页面导航取消
      }
      onEvent?.({ type: dialog.type(), message: dialog.message().slice(0, 120), accepted });
      // 已放开限制：默认持续接受，不做一次性消费
    });
  }

  /** 动作前武装（兼容保留）：默认策略已为接受，此方法仅用于附加原因记录。 */
  armOnce(page: PagePort, reason: string): void {
    this.install(page);
    this.policies.set(page as unknown as object, { accept: true, reason });
  }
}
