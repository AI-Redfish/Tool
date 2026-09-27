import type { ActionStep, GoalStep } from './types.js';
import { err, PauseSignal } from './errors.js';
import { verifyExpects } from './locator.js';
import { diffObservation, observePage, waitForSettle, type PageObservation } from './observe.js';
import { GOAL_ACTIONS, type GoalAction, type JudgePort } from './judge.js';
import { performAction, type ArtifactSink, type LedgerHook } from './executor.js';
import type { DialogManager } from './connectors.js';
import type { PagePort } from './ports.js';
import { originOf } from './policy.js';

/**
 * GoalExecutor（DESIGN §6.1/§6.3）：语义目标局部循环。
 * 观察 → Jev fan-out → 策略校验 → 执行 → 再观察/验证；一个 goal 一个可观察结果。
 * 循环/歧义/阻塞/错误映射固定（DESIGN §6.3），不产生新状态。
 */

export interface GoalLoopOptions {
  goal: string;
  values: Record<string, unknown>;
  valuesKeys: string[];
  judge: JudgePort;
  modelOrigins: string[];
  allowedOrigins: string[];
  maxActions: number;
  maxJevRequests: number;
  /** 两类模型累计 token 上限（DESIGN §6.4）；undefined = 用配置默认。 */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  actionTimeoutMs: number;
  /** 阈值来自 config.jev（dev 初值，须按业务校准，DESIGN §6.3）。 */
  thresholds: { doneAt: number; confirmLow: number; confirmHigh: number; blockedAt: number; errorAt: number };
  artifacts: ArtifactSink;
  ledger: LedgerHook;
  cancelFlag: { cancelled: boolean };
  dialogs?: DialogManager;
  allowedUploadDirs?: string[];
  maxUploadBytes?: number;
  /** 派发前的策略闸门：未授权抛 PauseSignal(needs_confirmation)（DESIGN §10）。 */
  requestApproval?: (step: ActionStep, actionRevision: number) => Promise<void>;
  nextActionRevision(): number;
}

export class GoalExecutor {
  constructor(
    private readonly page: PagePort,
    private readonly opts: GoalLoopOptions,
  ) {}

  async run(expect: GoalStep['expect']): Promise<{ rounds: number; verification: { by: 'semantic'; ok: boolean } }> {
    if (!this.opts.judge.available()) {
      throw err('JEV_NOT_CONFIGURED', '语义目标需要 Jev；纯确定性 execute 不调用模型');
    }
    const { judge } = this.opts;
    let prev: PageObservation | undefined;
    const recentActions: string[] = [];
    let rounds = 0;

    while (true) {
      if (this.opts.cancelFlag.cancelled) throw err('POLICY_BLOCKED', '任务已取消');
      if (rounds >= this.opts.maxActions) throw err('BUDGET_EXCEEDED', `goal 内动作数超过预算 ${this.opts.maxActions}`);
      if (judge.usage().jevRequests >= this.opts.maxJevRequests) {
        throw err('BUDGET_EXCEEDED', `Jev 请求数超过预算 ${this.opts.maxJevRequests}`);
      }
      rounds += 1;
      if (judge.usage().inputTokens + judge.usage().outputTokens > (this.opts.maxInputTokens ?? Number.MAX_SAFE_INTEGER) + (this.opts.maxOutputTokens ?? Number.MAX_SAFE_INTEGER)) {
        throw err('BUDGET_EXCEEDED', '模型 token 累计超过预算');
      }
      await waitForSettle(this.page, 8000);
      const obs = await observePage(this.page, { allowedOrigins: this.opts.allowedOrigins });
      const diff = diffObservation(prev, obs);
      prev = obs;

      // 云模型外发域检查（DESIGN §10：modelOrigins 为空 = 默认禁止外发）
      if (!this.opts.modelOrigins.includes(originOf(obs.url))) {
        throw new PauseSignal('needs_input', `当前页 origin 不在 modelOrigins 内，禁止云模型外发（空列表 = 全部禁止）: ${originOf(obs.url)}`);
      }

      const decision = await judge.decideRound({
        goal: this.opts.goal,
        observation: obs,
        valuesKeys: this.opts.valuesKeys,
        recentActions,
        diff,
      });

      // 判定→状态映射固定（DESIGN §6.3）；阈值来自配置（须按业务数据校准）
      if (decision.blocked >= this.opts.thresholds.blockedAt) {
        throw new PauseSignal('needs_input', `页面疑似被阻塞（p=${decision.blocked.toFixed(2)}），转人工处理`);
      }
      if (decision.error >= this.opts.thresholds.errorAt) {
        throw err('ACTION_FAILED', `页面显示错误（p=${decision.error.toFixed(2)}）`);
      }
      const doneMid = decision.done >= this.opts.thresholds.confirmLow && decision.done < this.opts.thresholds.doneAt;
      if (decision.done >= this.opts.thresholds.doneAt || (doneMid && decision.doneConfirm >= this.opts.thresholds.confirmHigh && decision.action === 'none')) {
        if (decision.done < this.opts.thresholds.doneAt) {
          // 中带 + 确认不足 → likely_done 不计成功（DESIGN §8.2）
          throw new PauseSignal('likely_done', `done=${decision.done.toFixed(2)} 处于确认带且未通过严格确认，需人工核验`);
        }
        const verdict = await verifyExpects(this.page, expect, { vars: {} as Record<string, unknown> }, this.opts.actionTimeoutMs);
        if (!verdict.ok && expect.length > 0) {
          throw new PauseSignal('likely_done', `done 信号足够但代码后置条件未通过: ${verdict.failures.map((f) => f.reason).join('; ')}`);
        }
        return { rounds, verification: { by: 'semantic', ok: true } };
      }
      if (doneMid) {
        // done 中带且 tool 仍提议动作 → 更严格的确认问句已在同轮 fan-out；未确认则暂停
        if (decision.doneConfirm < this.opts.thresholds.confirmHigh && decision.action !== 'none') {
          continue; // 有明确下一动作，继续执行
        }
        if (decision.action === 'none') {
          throw new PauseSignal('likely_done', `done=${decision.done.toFixed(2)} 证据不足，需人工核验`);
        }
      }

      if (decision.action === 'none' || decision.targetIndex === null) {
        throw new PauseSignal('ambiguous', `Jev 无法选出下一步（action=${decision.action}）`);
      }
      // targetIndex 对应本轮实际发送给模型的候选切片（修复切片后索引错位）
      const candidate = decision.candidates[decision.targetIndex];
      if (!candidate) throw new PauseSignal('ambiguous', '目标候选过期（快照漂移），需重新观察');

      const target = locatorFromCandidate(candidate);
      const step: ActionStep = {
        id: `g${rounds}`,
        kind: 'action',
        action: mapGoalAction(decision.action),
        target,
        valuesRef: decision.valueKey ?? undefined,
        expect: [],
      };

      // 循环检测：同 (action,target) 连续 3 次且页面无实质变化
      const sig = `${step.action}|${candidate.role}|${candidate.name}`;
      recentActions.push(sig);
      if (recentActions.length >= 3) {
        const tail = recentActions.slice(-3);
        if (tail.every((t) => t === sig) && !diff.urlChanged && diff.elementsAdded + diff.elementsRemoved === 0) {
          throw new PauseSignal('ambiguous', '连续 3 次相同动作且页面无变化，判定为循环');
        }
      }

      // PolicyGate 在 TaskService 层注入；未授权抛 PauseSignal，动作不派发（DESIGN §10）。
      // 注意：策略批准 ≠ 对话框自动接受授权（DESIGN §4.4 的边界不得混淆）。
      const actionRevision = this.opts.nextActionRevision();
      if (this.opts.requestApproval) {
        await this.opts.requestApproval(step, actionRevision);
      }
      await performAction(this.page, step, {
        vars: {} as Record<string, unknown>,
        values: this.opts.values,
        artifacts: this.opts.artifacts,
        ledger: this.opts.ledger,
        actionRevision,
        actionTimeoutMs: this.opts.actionTimeoutMs,
        cancelFlag: this.opts.cancelFlag,
        dialogs: this.opts.dialogs,
        allowedUploadDirs: this.opts.allowedUploadDirs,
        maxUploadBytes: this.opts.maxUploadBytes,
      });
    }
  }
}

function mapGoalAction(a: GoalAction): ActionStep['action'] {
  switch (a) {
    case 'press':
    case 'select':
    case 'scroll':
    case 'wait':
    case 'fill':
    case 'click':
      return a;
    case 'none':
      throw err('ACTION_FAILED', 'none 不是可执行动作');
    default: {
      const never: never = a;
      throw err('ACTION_FAILED', `未知 goal 动作: ${String(never)}`);
    }
  }
}

function locatorFromCandidate(c: PageObservation['elements'][number]) {
  if (c.text && c.name && c.text === c.name) {
    return { by: 'text' as const, text: c.name, exact: false };
  }
  return { by: 'role' as const, role: c.role, name: c.name || undefined, exact: false };
}
