import type { ActionStep, ErrorCode, FlowStep, StepResult } from './types.js';
import { err, PauseSignal } from './errors.js';
import { resolveLocator, resolveVarPath, verifyExpects } from './locator.js';
import { performAction, type ArtifactSink, type LedgerHook, type PerformContext } from './executor.js';
import type { DialogManager } from './connectors.js';
import type { PagePort } from './ports.js';

/**
 * FlowExecutor（DESIGN §8.1）：顺序 action/assert/extract + 单层 branch + 有界 forEach。
 * 实际展开步骤计入全局 maxSteps（不只是计划数组长度）；跨页迭代不保留过期 elementId。
 */

export interface FlowRunContext {
  vars: Record<string, unknown>;
  values: Record<string, unknown>;
  artifacts: ArtifactSink;
  ledger: LedgerHook;
  /** 每个动作派发前分配递增序号（审批 grant 绑定该序号，DESIGN §10）。 */
  nextActionRevision(): number;
  actionTimeoutMs: number;
  /** 页面状态类断言的重试窗口（毫秒，0 = 单发）。 */
  expectRetryMs?: number;
  cancelFlag: { cancelled: boolean };
  dialogs?: DialogManager;
  acceptDialogOnce?: boolean;
  maxSteps: number;
  /** 已派发动作数上限（DESIGN §6.4 预算）。 */
  maxActions: number;
  /** 上传授权目录与大小上限（透传 executor 安全检查，DESIGN §10）。 */
  allowedUploadDirs?: string[];
  maxUploadBytes?: number;
  /** 动作派发前钩子：PolicyGate + 审批消费（DESIGN §8.2/§10）；抛错则动作不派发。 */
  beforeAction?: (step: ActionStep) => Promise<{ acceptDialogOnce?: boolean } | void>;
  /** 每个步骤边界的截止检查（超限抛错终止）。 */
  checkDeadline?: () => void;
  /** checkpoint：每个顶层步骤完成、每次 forEach 迭代后调用（崩溃后不重放副作用）。 */
  onCheckpoint?: () => void;
  onProgress?: (r: StepResult) => void;
  goalRunner?: GoalRunner;
}

export type GoalRunner = (
  page: PagePort,
  step: Extract<FlowStep, { kind: 'goal' }>,
  ctx: FlowRunContext,
) => Promise<void | { rounds: number }>;

export interface FlowRunResult {
  stepResults: StepResult[];
  vars: Record<string, unknown>;
}

export class FlowExecutor {
  private stepCount = 0;
  private actionCount = 0;
  private readonly results: StepResult[] = [];

  constructor(
    private readonly page: PagePort,
    private readonly ctx: FlowRunContext,
  ) {}

  async run(steps: FlowStep[]): Promise<FlowRunResult> {
    await this.runList(steps);
    return { stepResults: this.results, vars: this.ctx.vars };
  }

  private tick(): void {
    this.stepCount += 1;
    if (this.stepCount > this.ctx.maxSteps) {
      throw err('BUDGET_EXCEEDED', `实际展开步骤超过预算 ${this.ctx.maxSteps}`);
    }
  }

  private async runList(steps: FlowStep[]): Promise<void> {
    for (const step of steps) {
      if (this.ctx.cancelFlag.cancelled) {
        const skipped: StepResult = { id: step.id, kind: step.kind, status: 'skipped' };
        this.results.push(skipped);
        this.ctx.onProgress?.(skipped);
        continue;
      }
      this.ctx.checkDeadline?.();
      const r = await this.runOne(step);
      this.results.push(r);
      this.ctx.onProgress?.(r);
      this.ctx.onCheckpoint?.();
    }
  }

  private async runOne(step: FlowStep): Promise<StepResult> {
    this.tick();
    const stepStart = Date.now();
    try {
      return this.decorate(await this.runOneInner(step), stepStart);
    } catch (e) {
      // 出事的那一步必须留在结果里。此前失败步骤直接抛出、不进 stepResults，
      // 调用方只看到前面成功的步骤，出事的那步凭空消失（实测：点击打开新标签导致
      // 后置条件失败时，envelope 里 stepResults 为空、actions 为 0，看着像什么都没做）。
      const code = (e as { code?: ErrorCode }).code;
      const failed: StepResult = {
        id: step.id,
        kind: step.kind,
        status: e instanceof PauseSignal ? 'paused' : 'failed',
        durationMs: Date.now() - stepStart,
        ...(code ? { error: { code, message: (e as Error).message.slice(0, 300) } } : {}),
      };
      this.results.push(failed);
      this.ctx.onProgress?.(failed);
      throw e;
    }
  }

  private decorate(r: StepResult, start: number): StepResult {
    return { ...r, durationMs: Date.now() - start };
  }

  private async runOneInner(step: FlowStep): Promise<StepResult> {
    switch (step.kind) {
      case 'action': {
        this.actionCount += 1;
        if (this.actionCount > this.ctx.maxActions) {
          throw err('BUDGET_EXCEEDED', `实际派发动作超过预算 ${this.ctx.maxActions}`);
        }
        const p = this.performCtx();
        if (this.ctx.beforeAction) {
          const gate = await this.ctx.beforeAction(step);
          if (gate?.acceptDialogOnce) p.acceptDialogOnce = true;
        }
        const out = await performAction(this.page, step, p);
        return { id: step.id, kind: 'action', status: 'done', artifactId: out.artifactId, evidence: out.evidence };
      }
      case 'assert': {
        const verdict = await verifyExpects(this.page, step.expect, { vars: this.ctx.vars, retryMs: this.ctx.expectRetryMs }, this.ctx.actionTimeoutMs);
        if (!verdict.ok) {
          throw err('ACTION_FAILED', `断言失败: ${verdict.failures.map((f) => f.reason).join('; ')}`.slice(0, 300), {
            details: { failures: verdict.failures, stepId: step.id },
          });
        }
        return { id: step.id, kind: 'assert', status: 'done' };
      }
      case 'extract': {
        const count = await resolveLocator(this.page, step.target).count();
        if (count === 0) throw err('ACTION_FAILED', `extract 目标不存在: ${JSON.stringify(step.target)}`);
        const loc = resolveLocator(this.page, step.target).first();
        const saved: Record<string, unknown> = {};
        for (const f of step.fields) {
          if (f === 'text') saved['text'] = await loc.innerText({ timeout: this.ctx.actionTimeoutMs });
          if (f === 'count') saved['count'] = count;
        }
        this.ctx.vars[step.saveAs] = saved;
        return { id: step.id, kind: 'extract', status: 'done', savedAs: step.saveAs };
      }
      case 'branch': {
        const actual = resolveVarPath(this.ctx.vars, step.variable);
        if (actual === step.equals) {
          await this.runList(step.then);
        }
        return { id: step.id, kind: 'branch', status: 'done' };
      }
      case 'forEach': {
        const items = this.ctx.vars[step.itemsVar];
        if (!Array.isArray(items)) {
          throw err('INVALID_INPUT', `forEach.itemsVar "${step.itemsVar}" 不是数组变量`);
        }
        const bounded = items.slice(0, Math.min(step.maxItems, 30));
        // 断点续跑：已完成的迭代不重跑（暂停/恢复后 cursor 停在本步骤顶部，
        // 用 processed 计数跳过，避免重放已执行副作用，DESIGN §8.1/§9.1）
        const processedBefore = Number(this.ctx.vars[`${step.itemsVar}.processed`] ?? 0);
        let iterations = Math.min(Number.isFinite(processedBefore) ? processedBefore : 0, bounded.length);
        for (; iterations < bounded.length; iterations++) {
          if (this.ctx.cancelFlag.cancelled) break;
          this.ctx.vars[step.itemVar] = bounded[iterations];
          await this.runList(step.body);
          this.ctx.vars[`${step.itemsVar}.processed`] = iterations + 1;
          this.ctx.onCheckpoint?.(); // 每次迭代后落盘，崩溃后从断点继续
        }
        // 逐项终态记录：未处理项不能计为成功（DESIGN §8.1）
        this.ctx.vars[`${step.itemsVar}.processed`] = iterations;
        this.ctx.vars[`${step.itemsVar}.total`] = items.length;
        if (iterations < items.length) {
          throw new PauseSignal('needs_input', `forEach 未处理完全部条目（${iterations}/${items.length}），已暂停待人工处理；已处理项已记录，恢复后从断点继续`);
        }
        return { id: step.id, kind: 'forEach', status: 'done', iterations };
      }
      case 'goal': {
        if (!this.ctx.goalRunner) throw err('INVALID_INPUT', 'goal 步骤需要 goalRunner（Jev 局部循环，P3）');
        const out = await this.ctx.goalRunner(this.page, step, this.ctx);
        // rounds 记入 iterations（DESIGN §11 task/step/round 关联）
        return { id: step.id, kind: 'goal', status: 'done', iterations: out?.rounds };
      }
      default: {
        const never: never = step;
        throw err('INVALID_INPUT', `未知步骤类型: ${JSON.stringify(never)}`);
      }
    }
  }

  private performCtx(): PerformContext {
    return {
      vars: this.ctx.vars,
      values: this.ctx.values,
      artifacts: this.ctx.artifacts,
      ledger: this.ctx.ledger,
      actionRevision: this.ctx.nextActionRevision(),
      actionTimeoutMs: this.ctx.actionTimeoutMs,
      expectRetryMs: this.ctx.expectRetryMs,
      cancelFlag: this.ctx.cancelFlag,
      dialogs: this.ctx.dialogs,
      acceptDialogOnce: this.ctx.acceptDialogOnce,
      allowedUploadDirs: this.ctx.allowedUploadDirs,
      maxUploadBytes: this.ctx.maxUploadBytes,
    };
  }
}
