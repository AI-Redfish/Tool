import { err } from './errors.js';
import type { TaskStatus } from './types.js';
import { isTerminal } from './types.js';

/**
 * 任务状态机（DESIGN §8.2）：
 * queued → running → done|failed|expired
 *   queued → failed（启动前被拒绝：隔离/策略/配置）
 *   running → paused → queued（显式恢复）
 *   queued/running/paused → cancelling → cancelled|failed
 *   queued/paused → expired；running → cancelling → expired|failed
 * 重启恢复：queued/running/paused → paused(interrupted) 或 expired；不自动回到 running。
 */

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  // queued → failed：任务在启动前被拒绝（隔离/策略），附错误收尾，不卡队列
  queued: ['running', 'cancelling', 'expired', 'cancelled', 'paused', 'failed'],
  running: ['done', 'failed', 'paused', 'cancelling', 'expired'],
  paused: ['queued', 'cancelled', 'expired'],
  cancelling: ['cancelled', 'failed', 'expired'],
  done: [],
  failed: [],
  expired: [],
  cancelled: [],
};

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return; // 幂等重放同一状态视为无操作
  if (!TRANSITIONS[from].includes(to)) {
    throw err('INTERNAL', `非法状态转移 ${from} → ${to}`);
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** 取消派发终态：cancelling 依据 stopReason 收敛。 */
export function resolveCancelling(stopReason: 'user_cancel' | 'deadline' | 'budget' | 'error'): TaskStatus {
  switch (stopReason) {
    case 'user_cancel':
      return 'cancelled';
    case 'deadline':
      return 'expired';
    case 'budget':
    case 'error':
      return 'failed';
  }
}

/** 重启恢复：遗留非终态任务的落点。 */
export function recoverStale(status: TaskStatus, deadlinePassed: boolean): { status: TaskStatus; pauseReason?: 'interrupted' } {
  if (isTerminal(status)) return { status };
  if (deadlinePassed) return { status: 'expired' };
  return { status: 'paused', pauseReason: 'interrupted' };
}
