import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ActInput,
  ArtifactMeta,
  CreateSessionInput,
  ExecuteTaskInput,
  FlowStep,
  PageCandidate,
  PauseReason,
  PendingApproval,
  RunTaskInput,
  SessionInfo,
  StepResult,
  TaskEnvelope,
  TaskStatus,
  ValueInput,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';
import type { CapabilityReport, ErrorCode } from './types.js';
import { ActionOutcomeUnknownError, JevError, PauseSignal, err } from './errors.js';
import type { JevBrowserConfig } from './config.js';
import { credentialPresent } from './config.js';
import { TaskStore, type TaskRow } from './store.js';
import { assertTransition, recoverStale, resolveCancelling } from './statemachine.js';
import { PolicyGate, originOf } from './policy.js';
import { observePage } from './observe.js';
import { verifyGrant } from './grants.js';
import { WRITE_ACTIONS, validatePlannedSteps } from './planner.js';
import type { JudgePort } from './judge.js';
import { TypeSafeJudge } from './judge.js';
import { OpenAICompatibleProvider, type PlannerProvider } from './planner.js';
import { DialogManager, PlaywrightConnector, selectPage } from './connectors.js';
import { FsArtifactSink, type ArtifactSink, type LedgerHook } from './executor.js';
import { FlowExecutor, type FlowRunContext, type GoalRunner } from './flow.js';
import { GoalExecutor } from './goal.js';
import type { BrowserConnector, BrowserPort, Logger, PagePort } from './ports.js';
import { consoleLogger, systemClock, type Clock } from './ports.js';
import { describeCapabilities } from './capabilities.js';

/** 取消/截止的内部信号（在步骤边界抛出，动作不派发）。 */
class DeadlineSignal extends Error {
  constructor() {
    super('deadline');
    this.name = 'DeadlineSignal';
  }
}

interface RunningCtx {
  taskId: string;
  cancelFlag: { cancelled: boolean };
  stopReason: 'user_cancel' | 'deadline' | 'budget' | 'error';
}

export interface SubmitOptions {
  idempotencyKey?: string;
}

export interface ResumeOptions {
  requestId: string;
  expectedRevision?: number;
  /** 未知结果/歧义/断连恢复暂停后，人工确认允许重跑当前步骤。 */
  rerunConfirmed?: boolean;
  /** 仅 run 模式：恢复时允许规划器对未完成后缀重规划（受 maxReplans 预算，DESIGN §7）。 */
  allowReplan?: boolean;
}

export interface CancelOptions {
  requestId: string;
  expectedRevision?: number;
}

const RETENTION_MS = 24 * 60 * 60_000; // 幂等/元数据拟保留 24h（DESIGN §9.1）

/** 核心编排（DESIGN §2/§8/§9）：会话、串行队列、预算、取消/恢复/审批、崩溃恢复。 */
export class Runtime {
  readonly store: TaskStore;
  readonly cfg: JevBrowserConfig;
  readonly policy: PolicyGate;
  readonly judge: JudgePort;
  readonly planner: PlannerProvider | null;
  readonly dialogs = new DialogManager();
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly connector: BrowserConnector;
  private readonly heartbeatTimer: NodeJS.Timeout | undefined;

  private browser: { port: BrowserPort; ownership: 'borrowed' | 'owned' } | null = null;
  private closed = false;
  /** resume(allowReplan) 的显式意图：taskId → 下次执行时对未完成后缀重规划。 */
  private readonly replanRequests = new Set<string>();
  private readonly sessionPages = new Map<string, PagePort>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly running = new Map<string, RunningCtx>();
  private readonly waiters = new Map<string, (env: TaskEnvelope) => void>();

  constructor(cfg: JevBrowserConfig, opts?: { store?: TaskStore; judge?: JudgePort; planner?: PlannerProvider; logger?: Logger; clock?: Clock; connector?: BrowserConnector }) {
    this.cfg = cfg;
    this.log = opts?.logger ?? consoleLogger();
    this.clock = opts?.clock ?? systemClock();
    this.store = opts?.store ?? new TaskStore(path.join(cfg.runtime.dataDir, 'tasks.db'));
    this.policy = new PolicyGate(cfg);
    this.judge = opts?.judge ?? new TypeSafeJudge(cfg.jev);
    this.planner = opts?.planner ?? this.buildPlanner();
    this.connector = opts?.connector ?? new PlaywrightConnector(cfg);
    // 平台用户级锁心跳：仅供人工诊断宿主是否存活；过期不自动抢锁（DESIGN §9.2）
    this.heartbeatTimer = setInterval(() => {
      try {
        this.store.kvSet(`lock:${this.profileKey()}`, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch {
        /* 存储不可用时静默；下一次操作会暴露 */
      }
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private buildPlanner(): PlannerProvider | null {
    if (!this.cfg.planner.enabled) return null;
    if (this.cfg.planner.provider !== 'openai-compatible') return null;
    const key = process.env[this.cfg.planner.apiKeyEnv];
    return new OpenAICompatibleProvider({ cfg: this.cfg.planner, apiKey: key });
  }

  /** 浏览器实例身份（锁/预约的 key，DESIGN §9.2）。 */
  profileKey(): string {
    const b = this.cfg.browser;
    return b.mode === 'attach' ? `attach:${b.engine}:${b.attach.endpoint}` : `launch:${b.engine}:${b.launch.userDataDir ?? 'default'}`;
  }

  // ------------------------------------------------------------------
  // 浏览器连接（宿主共享一条连接）
  // ------------------------------------------------------------------

  private connectMs: number | undefined;

  private async ensureBrowser(): Promise<{ browser: BrowserPort; ownership: 'borrowed' | 'owned' }> {
    if (this.browser) return { browser: this.browser.port, ownership: this.browser.ownership };
    this.acquireHostLock();
    const t0 = this.clock.now();
    const res = await this.connector.connect();
    // 连接耗时（含授权等待）计入任务度量（DESIGN §11 queue/connect 分段）
    this.connectMs = this.clock.now() - t0;
    this.browser = { port: res.browser, ownership: res.ownership };
    return { browser: res.browser, ownership: res.ownership };
  }

  /** 平台用户级锁（尽力而为）：owner PID 存活检查；不宣称锁住人工/其他软件。 */
  private acquireHostLock(): void {
    const key = `lock:${this.profileKey()}`;
    const raw = this.store.kvGet(key);
    if (raw) {
      try {
        const prev = JSON.parse(raw) as { pid: number };
        if (prev.pid !== process.pid && isPidAlive(prev.pid)) {
          throw err('BROWSER_BUSY', `浏览器已被另一宿主进程占用 (pid=${prev.pid})；请通过其 API 访问或先停止该进程`);
        }
      } catch (e) {
        if ((e as JevError).code === 'BROWSER_BUSY') throw e;
      }
    }
    this.store.kvSet(key, JSON.stringify({ pid: process.pid, at: Date.now() }));
  }

  // ------------------------------------------------------------------
  // 会话
  // ------------------------------------------------------------------

  async createSession(principal: string, input: CreateSessionInput): Promise<SessionInfo> {
    validateOrigins(input.allowedOrigins, input.modelOrigins);
    validateSessionTarget(input.target);
    const { browser } = await this.ensureBrowser();
    const context = browser.contexts()[0];
    if (!context) throw err('PAGE_NOT_RESOLVED', '浏览器没有可用 context');
    const sessionId = newId('s');
    let page: PagePort | null = null;
    let candidates: PageCandidate[] = [];

    if (input.target.kind === 'new') {
      const url = input.target.url;
      // 新建页必须在会话授权域内：任务不能自行扩大权限（DESIGN §8.1）
      const decision = this.policy.decide({ action: 'navigate', pageUrl: url, navigateTo: url, sessionAllowedOrigins: input.allowedOrigins });
      if (!decision.allow) throw err(decision.code, decision.reason);
      page = await context.newPage(url);
      this.sessionPages.set(sessionId, page);
    } else {
      let sel = await selectPage(context, input.target.pageId);
      // 仅列出已授权域的脱敏页面元数据（DESIGN §8.1；宿主级 + 会话级许可的并集）
      const authorized = new Set([...this.cfg.safety.allowedOrigins, ...input.allowedOrigins]);
      const filterAuthorized = (cs: PageCandidate[]) => cs.filter((c) => authorized.has(originOf(c.url)));
      let filtered = filterAuthorized(sel.candidates);
      // 未指定页且唯一匹配（过滤后仅剩一个授权页）→ 自动绑定；否则保持 awaiting_page（DESIGN §8.1）
      if (!input.target.pageId && !sel.page && filtered.length === 1) {
        sel = await selectPage(context, filtered[0]!.pageId);
        filtered = filterAuthorized(sel.candidates);
      }
      candidates = filtered;
      if (sel.page) {
        page = sel.page;
        this.sessionPages.set(sessionId, page);
      }
    }

    const status = page ? 'ready' : 'awaiting_page';
    const row = {
      sessionId,
      principal,
      status,
      pageId: page ? guessPageId(context, page) : input.target.kind === 'existing' ? input.target.pageId ?? null : null,
      allowedJson: JSON.stringify(input.allowedOrigins),
      modelJson: JSON.stringify(input.modelOrigins),
    };
    this.store.upsertSession(row);
    return {
      sessionId,
      status,
      pageId: row.pageId ?? undefined,
      candidates: page ? undefined : candidates,
      allowedOrigins: input.allowedOrigins,
      modelOrigins: input.modelOrigins,
    };
  }

  async listPages(principal: string, sessionId: string): Promise<PageCandidate[]> {
    const s = this.requireSession(principal, sessionId);
    const { browser } = await this.ensureBrowser();
    const context = browser.contexts()[0];
    const sel = await selectPage(context, s.pageId ?? undefined);
    // 仅列出已授权域的脱敏页面元数据（DESIGN §8.1）
    const authorized = new Set([...this.cfg.safety.allowedOrigins, ...(JSON.parse(s.allowedJson) as string[])]);
    return sel.candidates.filter((c) => authorized.has(originOf(c.url)));
  }

  async selectPage(principal: string, sessionId: string, pageId: string): Promise<SessionInfo> {
    const s = this.requireSession(principal, sessionId);
    const { browser } = await this.ensureBrowser();
    const context = browser.contexts()[0];
    const sel = await selectPage(context, pageId);
    if (!sel.page) throw err('PAGE_NOT_RESOLVED', `pageId 不存在: ${pageId}`);
    this.sessionPages.set(sessionId, sel.page);
    const row = { ...s, status: 'ready' as const, pageId };
    this.store.upsertSession(row);
    return { sessionId, status: 'ready', pageId, allowedOrigins: JSON.parse(s.allowedJson) as string[], modelOrigins: JSON.parse(s.modelJson) as string[] };
  }

  async disconnect(principal: string, sessionId: string, opts: { detachTask?: boolean } = {}): Promise<{ disconnected: boolean }> {
    const s = this.requireSession(principal, sessionId);
    const active = this.store.listStale(['queued', 'running', 'cancelling']).filter((t) => t.sessionId === sessionId);
    if (active.length > 0) throw err('SESSION_BUSY', `会话仍有活动任务: ${active.map((t) => t.taskId).join(',')}`);
    const pausedTasks = this.store.listStale(['paused']).filter((t) => t.sessionId === sessionId);
    if (pausedTasks.length > 0 && !opts.detachTask) {
      throw err('SESSION_BUSY', `会话有暂停任务，需显式 detachTask=true（保留预约与审批需求）: ${pausedTasks.map((t) => t.taskId).join(',')}`);
    }
    this.sessionPages.delete(sessionId);
    this.store.upsertSession({ ...s, status: 'disconnected' });
    // 最后一个绑定页且整个 profile 无暂停预约时才释放宿主连接（DESIGN §4.3）
    const remainingPaused = this.store.listStale(['paused']);
    if (this.sessionPages.size === 0 && remainingPaused.length === 0 && this.browser) {
      await this.browser.port.close().catch(() => undefined);
      this.browser = null;
      this.store.kvDel(`lock:${this.profileKey()}`);
    }
    return { disconnected: true };
  }

  // ------------------------------------------------------------------
  // 任务提交
  // ------------------------------------------------------------------

  async execute(principal: string, sessionId: string, input: ExecuteTaskInput, opts: SubmitOptions = {}): Promise<TaskEnvelope> {
    const s = this.requireSession(principal, sessionId);
    if (s.status !== 'ready') throw err('SESSION_NOT_READY', `会话未就绪（${s.status}），先 select-page`);
    validateExecuteSteps(input.steps);
    // 含 goal 步骤时需要 Jev：提前快速失败，而不是执行一半后失败（DESIGN §6.1）
    if (input.steps.some((st) => st.kind === 'goal') && !this.judge.available()) {
      throw err('JEV_NOT_CONFIGURED', `execute 中的 goal 步骤需要 Jev key（${this.cfg.jev.apiKeyEnv}）`);
    }
    return this.enqueueTask(principal, sessionId, 'execute', input, opts, input.budget);
  }

  async run(principal: string, sessionId: string, input: RunTaskInput, opts: SubmitOptions = {}): Promise<TaskEnvelope> {
    const s = this.requireSession(principal, sessionId);
    if (s.status !== 'ready') throw err('SESSION_NOT_READY', `会话未就绪（${s.status}）`);
    if (!input.successCriteria || !input.successCriteria.trim()) {
      throw err('INVALID_INPUT', 'run 需要 successCriteria（DESIGN §8.1：防止规划器自证成功）');
    }
    if (!this.planner) {
      throw err('PLANNER_NOT_CONFIGURED', 'planner 未启用或未配置 provider/baseUrl/model');
    }
    if (!this.judge.available()) {
      throw err('JEV_NOT_CONFIGURED', 'run 的任务级验收需要 Jev key；纯确定性 execute 不需要它');
    }
    return this.enqueueTask(principal, sessionId, 'run', input, opts, input.budget);
  }

  async act(principal: string, sessionId: string, input: ActInput, opts: SubmitOptions = {}): Promise<TaskEnvelope> {
    this.requireSession(principal, sessionId);
    validateExecuteSteps([input.step]);
    return this.enqueueTask(principal, sessionId, 'act', { sessionId, steps: [input.step], values: input.values }, opts);
  }

  private async enqueueTask(
    principal: string,
    sessionId: string,
    mode: 'execute' | 'run' | 'act',
    request: object,
    opts: SubmitOptions,
    budget?: { deadlineAt?: number },
  ): Promise<TaskEnvelope> {
    if (this.closed) throw err('INTERNAL', '宿主已关闭，拒绝新任务');
    this.reapExpired();
    const now = this.clock.now();
    const bodyHash = sha256(JSON.stringify(request));
    const taskId = newId('t');
    const deadline = Math.min(now + this.cfg.runtime.taskTtlMs, budget?.deadlineAt ?? Number.MAX_SAFE_INTEGER);
    const row: TaskRow = {
      taskId,
      sessionId,
      principal,
      mode,
      status: 'queued',
      pauseReason: null,
      revision: 0,
      requestJson: JSON.stringify(request),
      cursor: 0,
      varsJson: '{}',
      resultsJson: '[]',
      metricsJson: JSON.stringify({ queuedMs: 0, runningMs: 0, actions: 0, jevRequests: 0, plannerRequests: 0 }),
      errorJson: null,
      goalJson: null,
      planJson: null,
      createdAt: now,
      updatedAt: now,
      deadlineAt: deadline === Number.MAX_SAFE_INTEGER ? null : deadline,
    };
    // 幂等记录与任务创建原子提交（DESIGN §8.3）；返回实际生效的 taskId
    const effectiveId = this.store.tx(() => {
      if (opts.idempotencyKey) {
        const pkey = `submit:${principal}:${mode}:${opts.idempotencyKey}`;
        const existing = this.store.findIdempotent(pkey);
        if (existing) {
          if (existing.bodyHash !== bodyHash) throw err('IDEMPOTENCY_CONFLICT', '相同 Idempotency-Key 但请求体不同');
          const prev = this.store.getTask(existing.taskId);
          if (prev) return existing.taskId;
        }
        this.store.putIdempotent(pkey, bodyHash, taskId);
      }
      this.store.insertTask(row);
      return taskId;
    });
    if (effectiveId !== taskId) {
      return this.envelope(this.store.getTask(effectiveId)!);
    }

    const pk = this.profileKey();
    const prev = this.queues.get(pk) ?? Promise.resolve();
    const next = prev.then(() => this.runTask(taskId)).catch((e) => {
      this.log.warn(`task ${taskId} 未捕获错误: ${(e as Error).message}`);
    });
    this.queues.set(pk, next);
    return this.envelope(this.store.getTask(taskId)!);
  }

  /** 等待任务到达终态或暂停（CLI 同步语义；HTTP 用轮询）。 */
  waitEnvelope(taskId: string): Promise<TaskEnvelope> {
    const row = this.store.getTask(taskId);
    if (!row) return Promise.reject(err('NOT_FOUND', `任务不存在: ${taskId}`));
    const env = this.envelope(row);
    if (env.status === 'paused' || isTerminalStatus(env.status)) return Promise.resolve(env);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const clean = this.waiters.delete(taskId);
        if (clean) reject(err('ACTION_TIMEOUT', '等待任务超时（宿主未在期限内收敛）', { retryable: true }));
      }, 30 * 60_000);
      // 不阻止宿主进程退出（等待器只是同进程便利设施）
      timer.unref?.();
      this.waiters.set(taskId, (e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
  }

  // ------------------------------------------------------------------
  // 任务执行
  // ------------------------------------------------------------------

  private async runTask(taskId: string): Promise<void> {
    if (this.closed) return;
    let row = this.store.getTask(taskId);
    if (!row) return;
    if (isTerminalStatus(row.status as TaskStatus)) return;

    const pk = this.profileKey();
    // 隔离检查：存在未知在途动作时拒绝新的写任务（只读请求放行，DESIGN §8.2）
    const isolationRaw = this.store.kvGet(`isolation:${pk}`);
    if (isolationRaw && JSON.parse(isolationRaw).taskId !== taskId && !isReadOnlyRequest(row)) {
      this.transitionTo(row, 'failed', { error: { code: 'BROWSER_BUSY', message: `存在未对账的未知在途动作（${JSON.parse(isolationRaw).taskId}），人工处理前不接新写任务`, retryable: false } });
      this.resolveWaiter(taskId);
      return;
    }

    // 排队等待预约释放（paused 也预约整个 profile，DESIGN §8.2）
    const queueDeadline = this.clock.now() + this.cfg.runtime.queueTimeoutMs;
    while (true) {
      const raw = this.store.kvGet(`reserve:${pk}`);
      if (!raw) break;
      try {
        const r = JSON.parse(raw) as { taskId: string };
        if (r.taskId === taskId) break;
      } catch {
        break;
      }
      if (this.clock.now() > queueDeadline || (row.deadlineAt !== null && this.clock.now() > row.deadlineAt)) {
        row = this.store.getTask(taskId)!;
        this.transitionTo(row, 'expired', { error: { code: 'BROWSER_BUSY', message: '等待浏览器预约释放超时', retryable: false } });
        this.resolveWaiter(taskId);
        return;
      }
      await this.clock.sleep(300);
    }
    row = this.store.getTask(taskId)!;
    if (row.status !== 'queued') {
      this.resolveWaiter(taskId);
      return;
    }
    this.store.kvSet(`reserve:${pk}`, JSON.stringify({ taskId, state: 'running', at: Date.now() }));
    this.store.kvSet(`lock:${pk}`, JSON.stringify({ pid: process.pid, at: Date.now() }));

    const startedAt = this.clock.now();
    // judge/planner 是 Runtime 级实例，usage 为累计值：记录任务起点，度量只计增量
    const judgeStart = { ...this.judge.usage() };
    const plannerStart = this.planner?.usage ? { ...this.planner.usage() } : null;
    const metrics = JSON.parse(row.metricsJson) as { queuedMs?: number; runningMs?: number; actions?: number; jevRequests?: number; plannerRequests?: number; inputTokens?: number; outputTokens?: number; connectMs?: number; jevModel?: string; plannerModel?: string; replans?: number };
    metrics.queuedMs = startedAt - row.createdAt;
    if (!this.transitionTo(row, 'running')) {
      this.resolveWaiter(taskId);
      return;
    }
    const cancelFlag: { cancelled: boolean } = { cancelled: false };
    const runningCtx: RunningCtx = { taskId, cancelFlag, stopReason: 'error' };
    this.running.set(taskId, runningCtx);

    if (this.connectMs !== undefined) metrics.connectMs = this.connectMs;
    const runDeadline = Math.min(
      row.deadlineAt ?? Number.MAX_SAFE_INTEGER,
      startedAt + this.cfg.runtime.timeoutMs,
    );
    let seq = this.store.maxActionSeq(taskId);
    const results: StepResult[] = JSON.parse(row.resultsJson) as StepResult[];
    const vars = JSON.parse(row.varsJson) as Record<string, unknown>;
    const request = JSON.parse(row.requestJson) as Record<string, unknown>;
    const session = this.store.getSession(row.sessionId);
    const allowedOrigins: string[] = session ? JSON.parse(session.allowedJson) : [];
    const modelOrigins: string[] = session ? JSON.parse(session.modelJson) : [];
    const artifactsDir = path.join(this.cfg.runtime.dataDir, 'artifacts', taskId);
    // 实测发现：FsArtifactSink 只写盘不登记，listArtifacts/artifactPath 全部为空——
    // 这里包一层，保存后原子登记进同一事务库（putArtifact）。
    const disk = new FsArtifactSink(artifactsDir);
    const register = (m: ArtifactMeta): ArtifactMeta => {
      this.store.putArtifact({
        artifactId: m.artifactId, taskId,
        filename: m.filename, size: m.size, sha256: m.sha256,
        path: path.join(artifactsDir, `${m.artifactId}-${m.filename}`),
        createdAt: this.clock.now(),
      });
      return m;
    };
    const artifacts: ArtifactSink = {
      save: (filename, data) => register(disk.save(filename, data)),
      saveDownload: (filename, tmpPath) => register(disk.saveDownload(filename, tmpPath)),
      dir: () => disk.dir(),
    };

    const pullUsage = () => {
      const ju = this.judge.usage();
      metrics.jevRequests = ju.jevRequests - judgeStart.jevRequests;
      metrics.inputTokens = ju.inputTokens - judgeStart.inputTokens;
      metrics.outputTokens = ju.outputTokens - judgeStart.outputTokens;
      if (ju.model) metrics.jevModel = ju.model;
      if (this.planner?.usage && plannerStart) {
        const pu = this.planner.usage();
        metrics.plannerRequests = Math.max(metrics.plannerRequests ?? 0, pu.requests - plannerStart.requests);
        metrics.inputTokens += pu.inputTokens - plannerStart.inputTokens;
        metrics.outputTokens += pu.outputTokens - plannerStart.outputTokens;
        if (pu.model) metrics.plannerModel = pu.model;
      }
    };
    const persist = (patch: Partial<{ cursor: number; goalJson: string | null; planJson: string | null }> = {}) => {
      const cur = this.store.getTask(taskId);
      if (!cur) return;
      pullUsage();
      this.store.transition(taskId, cur.revision, {
        status: cur.status,
        cursor: patch.cursor ?? cur.cursor,
        varsJson: JSON.stringify(vars),
        resultsJson: JSON.stringify(results),
        metricsJson: JSON.stringify(metrics),
        goalJson: patch.goalJson !== undefined ? patch.goalJson : cur.goalJson,
        planJson: patch.planJson !== undefined ? patch.planJson : cur.planJson,
      });
    };

    const ledger: LedgerHook = {
      prepared: (s, rev) => this.store.setActionState(taskId, rev, 'prepared', JSON.stringify(s)),
      inFlight: (s, rev) => this.store.setActionState(taskId, rev, 'in_flight', JSON.stringify(s)),
      finished: (s, rev, state, detail) => this.store.setActionState(taskId, rev, state, undefined, detail ? JSON.stringify({ stepId: s.id, ...detail }) : undefined),
    };

    const gateSessionId = row.sessionId;
    const gate = this.makeGate(taskId, () => allowedOrigins, () => this.sessionPages.get(gateSessionId)?.url() ?? '');

    try {
      const page = this.requirePage(row.sessionId);
      let steps: FlowStep[];
      if (row.mode === 'run') {
        const req = request as unknown as { goal: string; successCriteria: string; values?: Record<string, ValueInput> };
        // 恢复 + 显式 allowReplan：对未完成后缀重规划（DESIGN §7：只改后缀，受 maxReplans 约束）
        if (row.planJson && this.replanRequests.has(taskId)) {
          this.replanRequests.delete(taskId);
          const replanner = this.planner;
          if (!replanner?.replan) throw err('PLANNER_NOT_CONFIGURED', '当前 planner 不支持重规划');
          const replans = metrics.replans ?? 0;
          if (replans >= this.cfg.runtime.maxReplans) {
            throw err('BUDGET_EXCEEDED', `重规划次数超过预算 ${this.cfg.runtime.maxReplans}`);
          }
          if ((metrics.plannerRequests ?? 0) + 1 > this.cfg.runtime.maxPlannerRequests) {
            throw err('BUDGET_EXCEEDED', `规划请求数超过预算 ${this.cfg.runtime.maxPlannerRequests}`);
          }
          const steps0 = JSON.parse(row.planJson) as FlowStep[];
          const doneIds = new Set(results.filter((r) => r.status === 'done').map((r) => r.id));
          const plannedSuffix = await replanner.replan({
            goal: req.goal,
            successCriteria: req.successCriteria,
            valuesKeys: Object.keys(req.values ?? {}),
            allowedOrigins,
            currentUrl: page.url(),
            completedStepIds: steps0.filter((st) => doneIds.has(st.id)).map((st) => st.id),
            pausedReason: row.pauseReason ?? 'needs_input',
          });
          metrics.replans = replans + 1;
          // 只替换未完成后缀：已完成步骤与其副作用记录原样保留（DESIGN §7）
          const merged = [...steps0.slice(0, row.cursor), ...plannedSuffix];
          persist({ planJson: JSON.stringify(merged) });
          row = this.store.getTask(taskId)!;
        }
        if (!row.planJson) {
          if (!this.planner) throw err('PLANNER_NOT_CONFIGURED', 'planner 未配置');
          if ((metrics.plannerRequests ?? 0) + 1 > this.cfg.runtime.maxPlannerRequests) {
            throw err('BUDGET_EXCEEDED', `规划请求数超过预算 ${this.cfg.runtime.maxPlannerRequests}`);
          }
          metrics.plannerRequests = (metrics.plannerRequests ?? 0) + 1;
          const planned = await this.planner.plan({
            goal: req.goal,
            successCriteria: req.successCriteria,
            valuesKeys: Object.keys(req.values ?? {}),
            allowedOrigins,
            currentUrl: page.url(),
          });
          if (planned.length === 0) {
            throw new PauseSignal('needs_input', '规划器无法生成计划（目标不可达或信息不足），需人工补充信息');
          }
          persist({ planJson: JSON.stringify(planned) });
          row = this.store.getTask(taskId)!;
          steps = planned;
        } else {
          steps = JSON.parse(row.planJson) as FlowStep[];
        }
      } else {
        steps = (request as unknown as { steps: FlowStep[] }).steps;
      }

      const goalRunner: GoalRunner = async (p, goalStep, fctx) => {
        const ge = new GoalExecutor(p, {
          goal: goalStep.goal,
          values: fctx.values,
          valuesKeys: Object.keys(fctx.values),
          judge: this.judge,
          modelOrigins,
          allowedOrigins,
          maxActions: this.cfg.runtime.maxActions,
          maxJevRequests: this.cfg.runtime.maxJevRequests,
          maxInputTokens: this.cfg.runtime.maxInputTokens,
          maxOutputTokens: this.cfg.runtime.maxOutputTokens,
          actionTimeoutMs: this.cfg.runtime.actionTimeoutMs,
          thresholds: {
            doneAt: this.cfg.jev.doneAt,
            confirmLow: this.cfg.jev.confirmLow,
            confirmHigh: this.cfg.jev.confirmHigh,
            blockedAt: this.cfg.jev.blockedAt,
            errorAt: this.cfg.jev.errorAt,
          },
          artifacts: fctx.artifacts,
          ledger: fctx.ledger,
          cancelFlag,
          dialogs: fctx.dialogs,
          allowedUploadDirs: this.cfg.safety.allowedUploadDirs,
          maxUploadBytes: this.cfg.safety.maxUploadBytes,
          requestApproval: async (step) => {
            await gate(step); // 未授权时抛 PauseSignal(needs_confirmation)，动作不派发
          },
          nextActionRevision: () => ++seq,
        });
        await ge.run(goalStep.expect);
      };

      const flowCtx: FlowRunContext = {
        vars,
        values: resolveValues((request as unknown as { values?: Record<string, ValueInput> }).values ?? {}),
        artifacts,
        ledger,
        nextActionRevision: () => ++seq,
        actionTimeoutMs: this.cfg.runtime.actionTimeoutMs,
        cancelFlag,
        dialogs: this.dialogs,
        allowedUploadDirs: this.cfg.safety.allowedUploadDirs,
        maxUploadBytes: this.cfg.safety.maxUploadBytes,
        maxSteps: this.cfg.runtime.maxSteps,
        maxActions: this.cfg.runtime.maxActions,
        beforeAction: async (step) => {
          await gate(step);
          return {};
        },
        checkDeadline: () => {
          if (cancelFlag.cancelled) throw err('POLICY_BLOCKED', '任务已取消');
          if (this.clock.now() > runDeadline) throw new DeadlineSignal();
        },
        onCheckpoint: () => {
          // cursor = 首个未完成的顶层步骤（断点续跑从这快开始，不重放已成功步骤）
          const doneIds = new Set(results.filter((r) => r.status === 'done').map((r) => r.id));
          const cursor = steps.findIndex((s) => !doneIds.has(s.id));
          persist({ cursor: cursor === -1 ? steps.length : cursor });
        },
        goalRunner,
        onProgress: (r) => {
          // 步骤结果必须进入 results（envelope.stepResults / cursor 计算 / 崩溃恢复都依赖它）
          results.push(r);
          if (r.kind === 'action' && r.status === 'done') metrics.actions = (metrics.actions ?? 0) + 1;
        },
      };

      // 断点续跑：cursor 之前的顶层步骤已完成（cursor 在每次 checkpoint 时推进）
      const remaining = steps.slice(row.cursor);
      const flow = new FlowExecutor(page, flowCtx);
      await flow.run(remaining);

      if (cancelFlag.cancelled) {
        row = this.store.getTask(taskId)!;
        metrics.runningMs = (metrics.runningMs ?? 0) + (this.clock.now() - startedAt);
        this.transitionTo(row, resolveCancelling(runningCtx.stopReason), { resultsJson: JSON.stringify(results), metricsJson: JSON.stringify(metrics) });
      } else {
        let verification: { by: 'deterministic' | 'semantic'; ok: boolean; detail?: string };
        if (row.mode === 'run') {
          const req = request as unknown as { successCriteria: string };
          // 任务级验收的外发同样受 modelOrigins 约束（DESIGN §10）
          if (!modelOrigins.includes(originOf(page.url()))) {
            throw new PauseSignal('needs_input', `任务级验收需要云模型，但当前页 origin 不在 modelOrigins 内: ${originOf(page.url())}`);
          }
          const p = await this.judge.check(
            { url: redactForEvidence(page.url()), doneSteps: results.filter((r) => r.status === 'done').map((r) => r.id) },
            `任务级验收：${req.successCriteria}`,
          );
          if (p < this.cfg.jev.doneAt) {
            // 步骤全成功但总目标未证实 → 不计 done（DESIGN §8.2）
            throw new PauseSignal('likely_done', `规划步骤已执行完，但任务级验收未证实（p=${p.toFixed(2)}）：${req.successCriteria}`);
          }
          verification = { by: 'semantic', ok: true, detail: `p=${p.toFixed(2)}` };
        } else {
          verification = { by: 'deterministic', ok: true };
        }
        row = this.store.getTask(taskId)!;
        metrics.runningMs = (metrics.runningMs ?? 0) + (this.clock.now() - startedAt);
        pullUsage();
        this.store.transition(taskId, row.revision, {
          status: 'done',
          pauseReason: null,
          errorJson: null,
          goalJson: JSON.stringify(verification),
          resultsJson: JSON.stringify(results),
          varsJson: JSON.stringify(vars),
          metricsJson: JSON.stringify(metrics),
        });
      }
    } catch (e) {
      row = this.store.getTask(taskId)!;
      metrics.runningMs = (metrics.runningMs ?? 0) + (this.clock.now() - startedAt);
      pullUsage();
      const metricsJson = JSON.stringify(metrics);
      if (e instanceof DeadlineSignal || cancelFlag.cancelled) {
        const target = e instanceof DeadlineSignal ? 'expired' : resolveCancelling(runningCtx.stopReason);
        this.transitionTo(row, target, { resultsJson: JSON.stringify(results), metricsJson });
      } else if (e instanceof PauseSignal) {
        const pending = (e.detail as { pendingApproval?: PendingApproval } | undefined)?.pendingApproval;
        const errorJson = pending
          ? JSON.stringify({ code: 'NEEDS_CONFIRMATION', message: e.message, retryable: false, pendingApproval: pending })
          : JSON.stringify({ code: pauseErrorCode(e.reason), message: e.message, retryable: false });
        this.transitionTo(row, 'paused', { errorJsonRaw: errorJson, resultsJson: JSON.stringify(results), metricsJson }, e.reason);
      } else if (e instanceof ActionOutcomeUnknownError) {
        // 结果未知：隔离 profile，人工对账前不接新写任务（DESIGN §8.2）
        this.store.kvSet(`isolation:${pk}`, JSON.stringify({ taskId, at: Date.now(), reason: 'ACTION_OUTCOME_UNKNOWN' }));
        this.transitionTo(row, 'paused', {
          errorJsonRaw: JSON.stringify({ code: 'ACTION_OUTCOME_UNKNOWN', message: e.message, retryable: false }),
          resultsJson: JSON.stringify(results),
          metricsJson,
        }, 'needs_input');
      } else {
        const jev = e as JevError;
        const code = jev.code ?? 'INTERNAL';
        this.transitionTo(row, 'failed', {
          // details（如断言失败清单）进入 envelope.evidence（DESIGN §8.2/§11）
          errorJsonRaw: JSON.stringify({ code, message: (e as Error).message.slice(0, 400), retryable: jev.retryable ?? false, details: jev.details }),
          resultsJson: JSON.stringify(results),
          metricsJson,
        });
      }
    } finally {
      this.running.delete(taskId);
      const final = this.store.getTask(taskId);
      if (final) {
        if (isTerminalStatus(final.status as TaskStatus)) {
          // 本任务终态且隔离记录属于本任务：人工已通过 rerunConfirmed 确认，解除隔离
          const iso = this.store.kvGet(`isolation:${pk}`);
          if (iso && JSON.parse(iso).taskId === taskId) {
            this.store.kvDel(`isolation:${pk}`);
          }
          this.store.kvDel(`reserve:${pk}`);
        } else if (final.status === 'paused') {
          this.store.kvSet(`reserve:${pk}`, JSON.stringify({ taskId, state: 'paused', at: Date.now() }));
        }
      }
      this.resolveWaiter(taskId);
    }
  }

  private makeGate(taskId: string, getAllowedOrigins: () => string[], getPageUrl: () => string) {
    return async (step: import('./types.js').ActionStep): Promise<{ acceptDialogOnce?: boolean } | undefined> => {
      const decision = this.policy.decide({
        action: step.action,
        target: step.target,
        pageUrl: getPageUrl(),
        navigateTo: step.action === 'navigate' ? String(step.value ?? '') : undefined,
        sessionAllowedOrigins: getAllowedOrigins(),
      });
      if (decision.allow) return {};
      if (decision.code === 'NEEDS_CONFIRMATION') {
        const actionRevision = this.store.maxActionSeq(taskId) + 1;
        const grant = this.store.findGrant(taskId, actionRevision);
        if (grant) {
          const key = process.env.JEV_BROWSER_APPROVAL_KEY;
          if (!key) throw err('GRANT_INVALID', '缺少 JEV_BROWSER_APPROVAL_KEY，无法核验审批');
          const payload = verifyGrant(grant.token, key, { taskId, actionRevision });
          if (this.store.consumeGrant(grant.grantId)) {
            return {}; // grant 与 actionRevision 绑定且一次性消费（DESIGN §10）
          }
        }
        throw new PauseSignal('needs_confirmation', `动作需要人工确认: ${decision.reason}`, {
          pendingApproval: {
            actionRevision,
            action: step.action,
            targetName: step.target && 'name' in step.target ? step.target.name : undefined,
            reason: decision.reason,
          },
        } as Record<string, unknown>);
      }
      throw err(decision.code, decision.reason);
    };
  }

  // ------------------------------------------------------------------
  // 查询 / 快照 / 取消 / 恢复 / 审批
  // ------------------------------------------------------------------

  getTask(principal: string, taskId: string): TaskEnvelope {
    const row = this.requireTask(principal, taskId);
    return this.envelope(row);
  }

  listArtifacts(principal: string, taskId: string): ArtifactMeta[] {
    this.requireTask(principal, taskId);
    return this.store.listArtifactsByTask(taskId).map(({ artifactId, filename, size, sha256 }) => ({ artifactId, filename, size, sha256 }));
  }

  /**
   * 只读快照（browser_snapshot）：不建任务、受 origin/modelOrigins 约束。
   * 经 profile 队列串行执行——不能绕开已暂停/运行任务窃读页面（DESIGN §8.3）。
   */
  async snapshot(principal: string, sessionId: string, opts: { forModel?: boolean } = {}): Promise<unknown> {
    const s = this.requireSession(principal, sessionId);
    const page = this.sessionPages.get(sessionId);
    if (!page) throw err('SESSION_NOT_READY', '会话没有可用页面');
    const allowed: string[] = JSON.parse(s.allowedJson);
    const modelOrigins: string[] = JSON.parse(s.modelJson);
    if (opts.forModel && !modelOrigins.includes(originOf(page.url()))) {
      // 空列表 = 全部禁止外发（DESIGN §10 默认不许可）
      throw err('ORIGIN_NOT_ALLOWED', `forModel 快照要求 origin ∈ modelOrigins（当前为空或未包含）: ${originOf(page.url())}`);
    }
    const pk = this.profileKey();
    const prev = this.queues.get(pk) ?? Promise.resolve();
    const run = prev.then(async () => {
      // 暂停任务预约整个 profile：预约期间拒绝其他会话的快照窃读（DESIGN §8.2）
      const raw = this.store.kvGet(`reserve:${pk}`);
      if (raw) {
        try {
          const r = JSON.parse(raw) as { taskId: string };
          const owner = this.store.getTask(r.taskId);
          if (owner && owner.sessionId !== sessionId) {
            throw err('SESSION_BUSY', `浏览器被任务 ${r.taskId}（其他会话）预约，禁止跨会话窃读`);
          }
        } catch (e) {
          if ((e as JevError).code) throw e;
        }
      }
      return observePage(page, { allowedOrigins: allowed });
    });
    this.queues.set(pk, run.then(() => undefined, () => undefined));
    return run;
  }

  /** 能力探测（DESIGN §11）：委托 capabilities.ts（单一事实来源）。 */
  capabilities(): CapabilityReport[] {
    return describeCapabilities(this.cfg);
  }

  async cancelTask(principal: string, taskId: string, opts: CancelOptions): Promise<TaskEnvelope> {
    const row = this.requireTask(principal, taskId);
    const replay = this.store.findIdempotent(`cancel:${taskId}:${opts.requestId}`);
    if (replay) return this.envelope(this.store.getTask(replay.taskId)!);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== row.revision) {
      throw err('REVISION_CONFLICT', `revision 冲突: 期望 ${opts.expectedRevision}，实际 ${row.revision}`);
    }
    const status = row.status as TaskStatus;
    if (isTerminalStatus(status)) {
      this.store.putIdempotent(`cancel:${taskId}:${opts.requestId}`, sha256('terminal'), taskId);
      return this.envelope(this.store.getTask(taskId)!);
    }
    const runningCtx = this.running.get(taskId);
    if (status === 'running' && runningCtx) {
      // 进入 cancelling：在途动作先 settle/隔离，之后按 stopReason 收敛（DESIGN §8.2）
      runningCtx.stopReason = 'user_cancel';
      runningCtx.cancelFlag.cancelled = true;
      this.store.transition(taskId, row.revision, {
        status: 'cancelling',
        errorJson: JSON.stringify({ code: 'CANCEL_PENDING', message: '取消中', retryable: false, stopReason: 'user_cancel' }),
      });
      this.store.putIdempotent(`cancel:${taskId}:${opts.requestId}`, sha256('cancelling'), taskId);
      return this.envelope(this.store.getTask(taskId)!);
    }
    if (status === 'cancelling') {
      this.store.putIdempotent(`cancel:${taskId}:${opts.requestId}`, sha256('cancelling'), taskId);
      return this.envelope(this.store.getTask(taskId)!);
    }
    const pk = this.profileKey();
    assertTransition(status, 'cancelled');
    this.store.transition(taskId, row.revision, { status: 'cancelled', pauseReason: null });
    if (status === 'paused') this.store.kvDel(`reserve:${pk}`);
    this.store.putIdempotent(`cancel:${taskId}:${opts.requestId}`, sha256('cancelled'), taskId);
    this.resolveWaiter(taskId);
    return this.envelope(this.store.getTask(taskId)!);
  }

  async resumeTask(principal: string, taskId: string, opts: ResumeOptions): Promise<TaskEnvelope> {
    let row = this.requireTask(principal, taskId);
    const replay = this.store.findIdempotent(`resume:${taskId}:${opts.requestId}`);
    if (replay) return this.envelope(this.store.getTask(replay.taskId)!);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== row.revision) {
      throw err('REVISION_CONFLICT', `revision 冲突: 期望 ${opts.expectedRevision}，实际 ${row.revision}`);
    }
    if (row.status !== 'paused') {
      throw err('TASK_NOT_RESUMABLE', `任务状态 ${row.status} 不可恢复（仅 paused 可恢复）`);
    }
    if (row.deadlineAt !== null && this.clock.now() > row.deadlineAt) {
      this.store.transition(taskId, row.revision, { status: 'expired', pauseReason: null });
      throw err('TASK_NOT_RESUMABLE', '任务已超过绝对有效期（expired），不可恢复');
    }
    const errInfo = row.errorJson ? (JSON.parse(row.errorJson) as { code?: string }) : null;
    // 未知结果/歧义/断连恢复必须显式确认（DESIGN §8.2：不确定不自动重放）
    const needsRerunConfirm = errInfo?.code === 'ACTION_OUTCOME_UNKNOWN' || row.pauseReason === 'ambiguous' || row.pauseReason === 'interrupted';
    if (opts.allowReplan && row.mode !== 'run') {
      throw err('INVALID_INPUT', 'allowReplan 仅适用于 run 模式任务');
    }
    if (opts.allowReplan && row.pauseReason !== 'ambiguous' && row.pauseReason !== 'needs_input') {
      throw err('INVALID_INPUT', `allowReplan 仅适用于 ambiguous/needs_input 暂停（当前 ${row.pauseReason}）`);
    }
    if (row.pauseReason === 'needs_confirmation') {
      const pending = errInfo ? (JSON.parse(row.errorJson!) as { pendingApproval?: PendingApproval }).pendingApproval : undefined;
      const grant = pending ? this.store.findGrant(taskId, pending.actionRevision) : undefined;
      if (!grant) {
        throw err('NEEDS_CONFIRMATION', `任务等待审批（actionRevision=${pending?.actionRevision}）；请先签发 grant 并调用 approve`);
      }
    } else if (needsRerunConfirm && !opts.rerunConfirmed) {
      throw err('TASK_NOT_RESUMABLE', '该暂停涉及未证实结果或人工核验，需要显式 rerunConfirmed=true');
    }
    // 页面重绑定（重启/断开后）：重建连接、重选页并核验（DESIGN §8.2）
    if (!this.sessionPages.has(row.sessionId) || this.sessionPages.get(row.sessionId)!.isClosed()) {
      const rebound = await this.rebindSessionPage(row.sessionId);
      if (!rebound) {
        return this.envelope(this.store.getTask(taskId)!); // 保持 paused，等用户 select-page
      }
    }
    row = this.store.getTask(taskId)!;
    if (row.status !== 'paused') return this.envelope(row);
    // 登记 replan 意图（runTask 执行时消费；不满足条件在下方拒绝后才登记）
    if (opts.allowReplan && row.planJson) {
      this.replanRequests.add(taskId);
    }
    this.store.transition(taskId, row.revision, { status: 'queued', pauseReason: null, errorJson: null });
    this.store.putIdempotent(`resume:${taskId}:${opts.requestId}`, sha256('queued'), taskId);
    const pk = this.profileKey();
    const prev = this.queues.get(pk) ?? Promise.resolve();
    this.queues.set(pk, prev.then(() => this.runTask(taskId)).catch(() => undefined));
    return this.envelope(this.store.getTask(taskId)!);
  }

  /** 恢复前重建会话页面绑定；失败保持 paused（不自动换页猜测）。 */
  private async rebindSessionPage(sessionId: string): Promise<boolean> {
    const session = this.store.getSession(sessionId);
    if (!session) return false;
    try {
      const { browser } = await this.ensureBrowser();
      const context = browser.contexts()[0];
      if (!context) return false;
      const sel = await selectPage(context, session.pageId ?? undefined);
      if (!sel.page) return false;
      this.sessionPages.set(sessionId, sel.page);
      this.store.upsertSession({ ...session, status: 'ready' });
      return true;
    } catch {
      return false;
    }
  }

  approveTask(principal: string, taskId: string, token: string): TaskEnvelope {
    const row = this.requireTask(principal, taskId);
    const key = process.env.JEV_BROWSER_APPROVAL_KEY;
    if (!key) throw err('GRANT_INVALID', '缺少 JEV_BROWSER_APPROVAL_KEY（独立签发凭据，不注入执行 Agent）');
    // 先校验并暂存 grant，不执行动作；resume 后派发前才原子消费（DESIGN §8.2）
    const payload = verifyGrant(token, key, { taskId });
    if (payload.expiresAt < this.clock.now()) throw err('GRANT_INVALID', 'grant 已过期');
    this.store.putGrant({
      grantId: payload.grantId,
      taskId,
      actionRevision: payload.actionRevision,
      token,
      expiresAt: payload.expiresAt,
    });
    return this.envelope(row);
  }

  artifactPath(principal: string, taskId: string, artifactId: string): { path: string; filename: string } {
    this.requireTask(principal, taskId);
    const art = this.store.getArtifact(artifactId);
    if (!art || art.taskId !== taskId) throw err('ARTIFACT_NOT_FOUND', `artifact 不存在: ${artifactId}`);
    return { path: art.path, filename: art.filename };
  }

  // ------------------------------------------------------------------
  // 崩溃恢复 / 过期回收 / 关闭
  // ------------------------------------------------------------------

  recoverOnStartup(): { recovered: number; expired: number; isolated: boolean } {
    this.store.pruneIdempotency(RETENTION_MS);
    this.pruneArtifacts();
    const unresolved = this.store.unresolvedActions();
    for (const a of new Set(unresolved.map((u) => u.taskId))) {
      const t = this.store.getTask(a);
      if (t?.status === 'done') {
        // done 任务的未收口行是账本滞后（任务级验收已通过，每步实际都验证成功），安全结算而非隔离
        for (const u of this.store.unresolvedActionsByTask(a)) {
          this.store.setActionState(a, u.seq, 'verified', undefined, JSON.stringify({ reason: 'task_done_settle' }));
        }
      } else {
        this.store.setActionState(a, this.store.maxActionSeq(a), 'unknown', undefined, JSON.stringify({ reason: 'host_crash' }));
      }
    }
    // 隔离标记自愈：被隔离任务若已 done，其 unknown 行一并结算后解除隔离（实测修复：历史遗留无法自清）
    const isoRaw = this.store.kvGet(`isolation:${this.profileKey()}`);
    if (isoRaw) {
      const isoTaskId = (JSON.parse(isoRaw) as { taskId?: string }).taskId;
      const isoTask = isoTaskId ? this.store.getTask(isoTaskId) : undefined;
      if (isoTask?.status === 'done') {
        for (const u of this.store.unknownActionsByTask(isoTaskId!)) {
          this.store.setActionState(isoTaskId!, u.seq, 'verified', undefined, JSON.stringify({ reason: 'task_done_settle' }));
        }
        this.store.kvDel(`isolation:${this.profileKey()}`);
      }
    }
    // 只对仍真实未收口的（非 done 任务）播种隔离；done 任务已结算不应再隔离
    const stillUnresolved = unresolved.filter((u) => this.store.getTask(u.taskId)?.status !== 'done');
    if (stillUnresolved.length > 0) {
      this.store.kvSet(`isolation:${this.profileKey()}`, JSON.stringify({ taskId: stillUnresolved[0].taskId, at: Date.now(), reason: 'host_crash' }));
    }
    let recovered = 0;
    let expired = 0;
    for (const row of this.store.listStale(['queued', 'running', 'cancelling', 'paused'])) {
      const deadlinePassed = row.deadlineAt !== null && this.clock.now() > row.deadlineAt;
      if (row.status === 'cancelling') {
        // 遗留 cancelling 按原 stopReason 收尾（DESIGN §8.2）
        const stopReason = row.errorJson ? (JSON.parse(row.errorJson) as { stopReason?: 'user_cancel' | 'deadline' | 'budget' | 'error' }).stopReason : undefined;
        const target = resolveCancelling(stopReason ?? 'user_cancel');
        this.store.transition(row.taskId, row.revision, { status: target, pauseReason: null });
        recovered += 1;
        continue;
      }
      if (deadlinePassed) {
        this.store.transition(row.taskId, row.revision, { status: 'expired', pauseReason: null });
        expired += 1;
        continue;
      }
      const target = recoverStale(row.status as TaskStatus, false);
      if (target.status !== row.status || target.pauseReason) {
        this.store.transition(row.taskId, row.revision, {
          status: target.status,
          pauseReason: target.pauseReason ?? row.pauseReason,
        });
        recovered += 1;
      }
    }
    for (const s of this.store.listSessionsByStatus('ready')) {
      // 会话页面绑定随宿主进程丢失；恢复时由 resume 重绑
      this.store.upsertSession({ ...s, status: 'disconnected' });
    }
    return { recovered, expired, isolated: unresolved.length > 0 };
  }

  /** 终态任务的 artifact 拟保留 24h，到期删除文件与元数据（DESIGN §9.1；仅限工具自有目录）。 */
  private pruneArtifacts(): void {
    const cutoff = this.clock.now() - RETENTION_MS;
    let rows: ReturnType<TaskStore['artifactsOfTerminalTasksOlderThan']> = [];
    try {
      rows = this.store.artifactsOfTerminalTasksOlderThan(cutoff);
    } catch {
      return;
    }
    for (const row of rows) {
      try {
        fs.rmSync(row.path, { force: true });
      } catch {
        // 文件可能已被人工另存/移动；元数据仍按保留期清理
      }
      this.store.deleteArtifact(row.artifactId);
    }
  }

  /** paused 超过 pauseTtl（或绝对 deadline）→ expired；预约一并释放（DESIGN §6.4）。 */
  reapExpired(): number {
    const now = this.clock.now();
    const pk = this.profileKey();
    let n = 0;
    for (const row of this.store.listStale(['paused', 'queued'])) {
      const pauseOvertime = now - row.updatedAt > this.cfg.runtime.pauseTtlMs;
      const deadlinePassed = row.deadlineAt !== null && now > row.deadlineAt;
      if (!pauseOvertime && !deadlinePassed) continue;
      const fresh = this.store.getTask(row.taskId);
      if (!fresh || fresh.status !== row.status) continue;
      this.store.transition(row.taskId, fresh.revision, {
        status: 'expired',
        pauseReason: null,
        errorJson: JSON.stringify({ code: 'BUDGET_EXCEEDED', message: deadlinePassed ? '超过任务绝对有效期' : '暂停超过 pauseTtl，任务过期', retryable: false }),
      });
      const reserve = this.store.kvGet(`reserve:${pk}`);
      if (reserve && JSON.parse(reserve).taskId === row.taskId) {
        this.store.kvDel(`reserve:${pk}`);
      }
      this.resolveWaiter(row.taskId);
      n += 1;
    }
    return n;
  }

  async close(opts: { graceMs?: number } = {}): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // 请求运行中任务在步骤边界收尾（在途动作按账本规则 settle/隔离，不强行中断）
    for (const ctx of this.running.values()) {
      ctx.stopReason = 'user_cancel';
      ctx.cancelFlag.cancelled = true;
    }
    const deadline = this.clock.now() + Math.max(0, opts.graceMs ?? 0);
    while (this.running.size > 0 && this.clock.now() < deadline) {
      await this.clock.sleep(50);
    }
    // 关闭后不再有转移动作：用当前快照收口所有悬挂等待者（须在 store.close 之前）
    for (const [taskId2, w] of this.waiters) {
      this.waiters.delete(taskId2);
      const row2 = this.store.getTask(taskId2);
      if (row2) w(this.envelope(row2));
    }
    if (this.browser) {
      await this.browser.port.close().catch(() => undefined);
      this.browser = null;
    }
    this.store.kvDel(`lock:${this.profileKey()}`);
    this.store.close();
  }

  // ------------------------------------------------------------------
  // 内部工具
  // ------------------------------------------------------------------

  private requireSession(principal: string, sessionId: string) {
    const s = this.store.getSession(sessionId);
    if (!s || s.principal !== principal) throw err('NOT_FOUND', `会话不存在: ${sessionId}`);
    return s;
  }

  private requireTask(principal: string, taskId: string): TaskRow {
    const row = this.store.getTask(taskId);
    if (!row || row.principal !== principal) throw err('NOT_FOUND', `任务不存在: ${taskId}`);
    return row;
  }

  private requirePage(sessionId: string): PagePort {
    const page = this.sessionPages.get(sessionId);
    if (!page) throw new PauseSignal('needs_input', '会话没有可用页面（重启/断开后需重新 select-page 并 resume）');
    if (page.isClosed()) throw new PauseSignal('needs_input', '会话页面已关闭（被人工关闭或崩溃），需重新 select-page 并 resume');
    return page;
  }

  private transitionTo(row: TaskRow, status: TaskStatus, patch: { error?: { code: string; message: string; retryable?: boolean }; errorJsonRaw?: string | null; resultsJson?: string; metricsJson?: string; pauseReason?: string; goalJson?: string; varsJson?: string; cursor?: number } = {}, pauseReason?: PauseReason): boolean {
    try {
      assertTransition(row.status as TaskStatus, status);
    } catch {
      // revision 已被并发操作推进：重新读取后再试一次
      const fresh = this.store.getTask(row.taskId);
      if (!fresh || !canTransitionSafe(fresh.status as TaskStatus, status)) return false;
      row = fresh;
    }
    const clearError = ['queued', 'running', 'done', 'cancelled', 'cancelling'].includes(status);
    const errorJson = patch.errorJsonRaw !== undefined
      ? patch.errorJsonRaw
      : patch.error
        ? JSON.stringify(patch.error)
        : clearError ? null : row.errorJson;
    const ok = this.store.transition(row.taskId, row.revision, {
      status,
      pauseReason: status === 'paused' ? pauseReason ?? row.pauseReason : null,
      errorJson,
      resultsJson: patch.resultsJson,
      metricsJson: patch.metricsJson,
      goalJson: patch.goalJson,
      varsJson: patch.varsJson,
      cursor: patch.cursor,
    }) === 1;
    if (ok && (isTerminalStatus(status) || status === 'paused')) this.resolveWaiter(row.taskId);
    return ok;
  }

  private resolveWaiter(taskId: string): void {
    const w = this.waiters.get(taskId);
    if (w) {
      this.waiters.delete(taskId);
      const row = this.store.getTask(taskId);
      if (row) w(this.envelope(row));
    }
  }

  envelope(row: TaskRow): TaskEnvelope {
    const parsedError = row.errorJson
      ? (JSON.parse(row.errorJson) as { code: string; message: string; retryable?: boolean; pendingApproval?: PendingApproval; stopReason?: string; details?: Record<string, unknown> })
      : undefined;
    const error: TaskEnvelope['error'] = parsedError && parsedError.code !== 'CANCEL_PENDING'
      ? { code: parsedError.code as ErrorCode, message: parsedError.message, retryable: parsedError.retryable ?? false }
      : undefined;
    let artifacts: ArtifactMeta[] = [];
    try {
      artifacts = this.store.listArtifactsByTask(row.taskId).map(({ artifactId, filename, size, sha256: hash }) => ({ artifactId, filename, size, sha256: hash }));
    } catch {
      artifacts = [];
    }
    const env: TaskEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      taskId: row.taskId,
      sessionId: row.sessionId,
      mode: row.mode as TaskEnvelope['mode'],
      revision: row.revision,
      status: row.status as TaskStatus,
      pauseReason: (row.pauseReason as TaskEnvelope['pauseReason']) ?? undefined,
      stepResults: safeParse(row.resultsJson, [] as StepResult[]),
      metrics: safeParse(row.metricsJson, { queuedMs: 0, runningMs: 0, actions: 0, jevRequests: 0, plannerRequests: 0 }),
      // 脱敏证据：断言失败清单等（DESIGN §8.2 evidence / §11 成功证据）
      evidence: parsedError?.details && Object.keys(parsedError.details).length > 0 ? [{ source: 'error', code: parsedError.code, ...parsedError.details }] : undefined,
      artifacts,
      error,
      pendingApproval: parsedError?.pendingApproval,
      goalVerification: row.goalJson ? safeParse(row.goalJson, undefined as unknown as TaskEnvelope['goalVerification']) : undefined,
    };
    return env;
  }
}

// ---------------------------------------------------------------------------
// 模块级工具
// ---------------------------------------------------------------------------

function canTransitionSafe(from: TaskStatus, to: TaskStatus): boolean {
  try {
    assertTransition(from, to);
    return true;
  } catch {
    return false;
  }
}

function isTerminalStatus(s: string): boolean {
  return ['done', 'failed', 'expired', 'cancelled'].includes(s);
}

function pauseErrorCode(reason: PauseReason): string {
  switch (reason) {
    case 'needs_confirmation':
      return 'NEEDS_CONFIRMATION';
    case 'likely_done':
      return 'POLICY_BLOCKED';
    default:
      return 'NEEDS_INPUT';
  }
}

/** 纯只读请求（隔离期间允许执行，不产生新副作用）。 */
function isReadOnlyRequest(row: TaskRow): boolean {
  try {
    const req = JSON.parse(row.requestJson) as { steps?: FlowStep[] };
    const steps = req.steps ?? [];
    return steps.length > 0 && steps.every((s) =>
      s.kind === 'assert' || s.kind === 'extract' ||
      (s.kind === 'action' && !WRITE_ACTIONS.has(s.action)),
    );
  } catch {
    return false;
  }
}

function redactForEvidence(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparsable)';
  }
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function guessPageId(context: import('./ports.js').ContextPort, page: PagePort): string {
  const idx = context.indexOfPage(page);
  return idx >= 0 ? `p${idx}` : 'p0';
}

function validateSessionTarget(target: import('./types.js').SessionTarget): void {
  if (typeof target !== 'object' || target === null) throw err('INVALID_INPUT', 'target 必须是对象');
  if (target.kind === 'new') {
    if (!target.url || !/^https?:\/\//i.test(String(target.url))) {
      throw err('INVALID_INPUT', `target.url 必须是 http/https URL: ${String((target as { url?: unknown }).url ?? '')}`);
    }
  } else if (target.kind === 'existing') {
    if (target.pageId !== undefined && !/^p\d+$/.test(target.pageId)) {
      throw err('INVALID_INPUT', `target.pageId 格式非法（应为 pages 返回的 id）: ${target.pageId}`);
    }
  } else {
    throw err('INVALID_INPUT', `target.kind 非法: ${String((target as { kind?: unknown }).kind)}`);
  }
}

function validateOrigins(allowed: string[], model: string[]): void {
  const re = /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i;
  for (const o of allowed) if (!re.test(o)) throw err('INVALID_INPUT', `allowedOrigins 非法: ${o}`);
  for (const o of model) if (!allowed.includes(o)) throw err('INVALID_INPUT', `modelOrigins 必须是 allowedOrigins 子集: ${o}`);
}

/** execute 输入校验：白名单 + 写操作必须提供后置条件 + id 全局唯一（DESIGN §8.1）。 */
export function validateExecuteSteps(steps: FlowStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0) throw err('INVALID_INPUT', 'steps 不能为空');
  validatePlannedSteps(JSON.parse(JSON.stringify(steps)) as unknown);
  const seen = new Set<string>();
  const walk = (list: FlowStep[]) => {
    for (const s of list) {
      if (seen.has(s.id)) throw err('INVALID_INPUT', `步骤 id 重复: ${s.id}`);
      seen.add(s.id);
      if (s.kind === 'branch') walk(s.then);
      if (s.kind === 'forEach') walk(s.body);
    }
  };
  walk(steps);
  let branchDepth = 0;
  for (const s of steps) {
    if (s.kind === 'action' && WRITE_ACTIONS.has(s.action) && (!s.expect || s.expect.length === 0)) {
      throw err('INVALID_INPUT', `动作 ${s.action}（${s.id}）必须提供 expect 后置条件`);
    }
    if (s.kind === 'branch') {
      branchDepth += 1;
      if (branchDepth > 1) throw err('INVALID_INPUT', 'branch 只允许一层');
    }
  }
}

/** secretRef 解析：从 JEV_BROWSER_SECRET_<NAME> 读取，缺失 → 暂停（DESIGN §6.3）。 */
export function resolveValues(values: Record<string, ValueInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'object' && v !== null && 'secretRef' in v) {
      const name = (v as { secretRef: string }).secretRef.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      const secret = process.env[`JEV_BROWSER_SECRET_${name}`];
      if (!secret) throw new PauseSignal('needs_input', `缺少 secret "${(v as { secretRef: string }).secretRef}"（环境变量 JEV_BROWSER_SECRET_${name}）`);
      out[k] = secret;
    } else {
      out[k] = v;
    }
  }
  return out;
}
