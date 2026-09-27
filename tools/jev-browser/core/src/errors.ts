import type { ErrorCode } from './types.js';

/** 统一错误：code 对应 envelope.error.code，message 面向调用者，details 已脱敏。 */
export class JevError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts?: { retryable?: boolean; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.details = opts?.details;
  }
}

export function err(code: ErrorCode, message: string, opts?: { retryable?: boolean; details?: Record<string, unknown> }): JevError {
  return new JevError(code, message, opts);
}

/** 动作超时但无法证明未执行（DESIGN §6.4）：调用方必须先核实后置状态。 */
export class ActionOutcomeUnknownError extends JevError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('ACTION_OUTCOME_UNKNOWN', message, { retryable: false, details });
    this.name = 'ActionOutcomeUnknownError';
  }
}

/** 暂停信号：GoalExecutor/FlowExecutor 抛出，由 TaskService 落为 paused。 */
export class PauseSignal extends Error {
  readonly reason: import('./types.js').PauseReason;
  readonly detail?: Record<string, unknown>;

  constructor(reason: import('./types.js').PauseReason, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'PauseSignal';
    this.reason = reason;
    this.detail = detail;
  }
}
