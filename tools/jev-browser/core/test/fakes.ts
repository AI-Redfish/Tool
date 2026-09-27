import type {
  BrowserConnector, BrowserPort, ContextPort, DialogPort, DownloadPort, LocatorPort, PagePort,
} from '../src/ports.js';
import type { LocatorSpec } from '../src/types.js';
import * as nodeFs from 'node:fs';

/** 离线假件：不启动浏览器、不联网（P1 退出门槛：多数单测无浏览器/无 key）。 */

export class FakeLocator implements LocatorPort {
  calls: string[] = [];
  constructor(
    private readonly state: { count: number; text: string; visible: boolean; clickError?: Error; fillError?: Error; log?: string[] },
  ) {}

  private record(entry: string): void {
    this.calls.push(entry);
    this.state.log?.push(entry);
  }

  async count(): Promise<number> {
    this.record('count');
    return this.state.count;
  }

  first(): LocatorPort {
    return this;
  }

  async click(): Promise<void> {
    this.record('click');
    if (this.state.clickError) throw this.state.clickError;
  }

  async fill(value: string): Promise<void> {
    this.record(`fill:${value}`);
    if (this.state.fillError) throw this.state.fillError;
  }

  async press(key: string): Promise<void> {
    this.calls.push(`press:${key}`);
  }

  async selectOption(value: string): Promise<void> {
    this.calls.push(`select:${value}`);
  }

  async setInputFiles(files: string[]): Promise<void> {
    this.record(`setInputFiles:${files.join(',')}`);
  }

  async isVisible(): Promise<boolean> {
    return this.state.visible;
  }

  async innerText(): Promise<string> {
    this.calls.push('innerText');
    return this.state.text;
  }

  async waitFor(): Promise<void> {
    this.calls.push('waitFor');
    if (!this.state.visible) throw new Error('timeout: element not visible');
  }
}

export interface FakePageOptions {
  url?: string;
  title?: string;
  bodyText?: string;
  elements?: Array<{ role: string; name: string }>;
  clickError?: Error;
  downloadAfterClick?: { filename: string; content: string };
  /** 共享的 locator 级调用记录（用于断言 fill/press 等实际参数）。 */
  locatorLog?: string[];
}

export class FakePage implements PagePort {
  currentUrl: string;
  calls: Array<string> = [];
  /** 每次动作后可选切换的 URL（模拟导航）。 */
  urlAfterNavigate?: string;
  downloads: Array<{ filename: string; content: string }> = [];
  isClosedFlag = false;
  readonly locatorLog: string[] = [];

  constructor(private readonly opts: FakePageOptions = {}) {
    this.currentUrl = opts.url ?? 'https://example.com/';
    if (opts.locatorLog) this.locatorLog = opts.locatorLog;
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.isClosedFlag;
  }

  async title(): Promise<string> {
    return this.opts.title ?? 'Example';
  }

  async goto(url: string): Promise<unknown> {
    this.calls.push(`goto:${url}`);
    this.currentUrl = this.urlAfterNavigate ?? url;
    return {};
  }

  locator(spec: LocatorSpec): LocatorPort {
    this.calls.push(`locator:${JSON.stringify(spec)}`);
    return new FakeLocator({
      count: this.opts.elements?.length ?? 1,
      text: this.opts.bodyText ?? 'Example',
      visible: true,
      clickError: this.opts.clickError,
      log: this.locatorLog,
    });
  }

  async evaluate<T = unknown>(script: string): Promise<T> {
    this.calls.push('evaluate');
    if (script.includes('readyState')) return true as T;
    if (script.includes('.includes(')) {
      const m = script.match(/includes\((".*?")\)/);
      const needle = m ? JSON.parse(m[1]) as string : '';
      return (this.opts.bodyText ?? '').includes(needle) as T;
    }
    if (script.includes('querySelectorAll')) {
      return {
        elements: (this.opts.elements ?? []).map((e, i) => ({ i, role: e.role, name: e.name, tag: 'button', text: e.name })),
        truncated: false,
      } as T;
    }
    return null as T;
  }

  async keyboardPress(key: string): Promise<void> {
    this.calls.push(`key:${key}`);
  }

  async mouseWheel(_dx: number, dy: number): Promise<void> {
    this.calls.push(`wheel:${dy}`);
  }

  async screenshot(opts?: { path?: string }): Promise<Buffer> {
    this.calls.push('screenshot');
    const buf = Buffer.from('png-bytes');
    if (opts?.path) nodeFs.writeFileSync(opts.path, buf);
    return buf;
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.calls.push(`wait:${ms}`);
  }

  async waitForDownload(): Promise<DownloadPort> {
    this.calls.push('waitForDownload');
    const dl = this.opts.downloadAfterClick;
    return {
      async saveAs(path: string): Promise<void> {
        nodeFs.writeFileSync(path, dl?.content ?? 'data');
      },
      async failure(): Promise<string | null> {
        return null;
      },
      suggestedFilename(): string {
        return dl?.filename ?? 'download.bin';
      },
    };
  }

  onDialog(handler: (d: DialogPort) => void): void {
    this.calls.push('onDialog');
    void handler;
  }

  markClosed(): void {
    this.isClosedFlag = true;
  }

  /** 测试辅助：模拟导航后的 URL 变化。 */
  setUrl(url: string): void {
    this.currentUrl = url;
  }
}

export class FakeContext implements ContextPort {
  constructor(public readonly pagesList: FakePage[]) {}

  pages(): PagePort[] {
    return this.pagesList.filter((p) => !p.isClosedFlag);
  }

  indexOfPage(page: PagePort): number {
    return this.pagesList.indexOf(page as FakePage);
  }

  async newPage(url?: string): Promise<PagePort> {
    const p = new FakePage({ url: url ?? 'about:blank' });
    this.pagesList.push(p);
    return p;
  }

  onPage(_handler: (page: PagePort) => void): void {
    /* 测试不需要 */
  }
}

export class FakeBrowser implements BrowserPort {
  closed = false;
  constructor(public readonly context: FakeContext) {}

  contexts(): ContextPort[] {
    return [this.context];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeConnector implements BrowserConnector {
  lastConnect = 0;
  constructor(private readonly browser: FakeBrowser) {}

  async connect(): Promise<{ browser: BrowserPort; ownership: 'borrowed' | 'owned'; kind: 'attach' }> {
    this.lastConnect += 1;
    return { browser: this.browser, ownership: 'borrowed', kind: 'attach' };
  }
}

// ---------------------------------------------------------------------------
// Jev 假件：脚本化决策（离线，不调用真实模型）
// ---------------------------------------------------------------------------

import type { JudgePort, RoundDecision, GoalAction } from '../src/judge.js';
import type { PageObservation } from '../src/observe.js';

export interface FakeJudgeScript {
  /** 每轮 decideRound 依次出队；耗尽后用 fallback。 */
  decisions: Array<Partial<RoundDecision>>;
  fallback?: Partial<RoundDecision>;
  /** check() 返回的概率。 */
  checkP?: number;
}

export class FakeJudge implements JudgePort {
  calls: Array<{ goal: string; elementCount: number }> = [];
  checkCalls: Array<string> = [];
  private stats = { jevRequests: 0, inputTokens: 0, outputTokens: 0 };

  constructor(private readonly script: FakeJudgeScript) {}

  available(): boolean {
    return true;
  }

  usage() {
    return { ...this.stats, jevRequests: this.stats.jevRequests };
  }

  async decideRound(input: { goal: string; observation: PageObservation }): Promise<RoundDecision> {
    this.stats.jevRequests += 1;
    this.stats.inputTokens += 100;
    this.stats.outputTokens += 10;
    this.calls.push({ goal: input.goal, elementCount: input.observation.elements.length });
    const next = this.script.decisions.length > 0 ? this.script.decisions.shift()! : this.script.fallback ?? {};
    return {
      done: 0,
      doneConfirm: 0,
      blocked: 0,
      error: 0,
      action: 'none' as GoalAction,
      targetIndex: null,
      valueKey: null,
      probabilities: {},
      candidates: input.observation.elements,
      ...next,
    };
  }

  async check(_state: Record<string, unknown>, question: string): Promise<number> {
    this.checkCalls.push(question);
    return this.script.checkP ?? 0.9;
  }
}
