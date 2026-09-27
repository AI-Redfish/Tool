/**
 * @ai-redfish/jev-browser-core —— 共享类型契约（拟议 v1，与 DESIGN.md §8 对应）
 *
 * 状态与原因分离（DESIGN §8.2）：status 只表达生命周期，pauseReason 表达暂停原因。
 */

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 任务与会话状态
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type PauseReason =
  | 'likely_done'
  | 'ambiguous'
  | 'needs_input'
  | 'needs_login'
  | 'needs_confirmation'
  | 'interrupted';

export type SessionStatus = 'awaiting_page' | 'ready' | 'disconnected';

export type StopReason = 'user_cancel' | 'deadline' | 'budget' | 'error';

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'done',
  'failed',
  'expired',
  'cancelled',
];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// 错误码（envelope.error.code 的合法值）
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'BROWSER_BUSY'
  | 'SESSION_BUSY'
  | 'SESSION_NOT_READY'
  | 'PAGE_NOT_RESOLVED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'POLICY_BLOCKED'
  | 'NEEDS_CONFIRMATION'
  | 'BUDGET_EXCEEDED'
  | 'ACTION_TIMEOUT'
  | 'ACTION_OUTCOME_UNKNOWN'
  | 'ACTION_FAILED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'JEV_NOT_CONFIGURED'
  | 'PLANNER_NOT_CONFIGURED'
  | 'PLANNER_INVALID_OUTPUT'
  | 'STORE_ERROR'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'GRANT_INVALID'
  | 'NOT_FOUND'
  | 'TASK_NOT_RESUMABLE'
  | 'ARTIFACT_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INTERNAL';

// ---------------------------------------------------------------------------
// 定位器与断言
// ---------------------------------------------------------------------------

/** 白名单定位器（DESIGN §8.1）：模型不得生成任意 XPath/JS。 */
export type LocatorSpec =
  | { by: 'role'; role: string; name?: string; exact?: boolean }
  | { by: 'label'; name: string; exact?: boolean }
  | { by: 'testId'; id: string }
  | { by: 'text'; text: string; exact?: boolean }
  | { by: 'css'; selector: string };

export type ExpectKind =
  | 'url_contains'
  | 'text_present'
  | 'visible'
  | 'hidden'
  | 'count_gte'
  | 'download_completed'
  | 'var_equals';

/** 后置条件：导航、写操作与下载必须提供（DESIGN §8.1）。 */
export interface ExpectSpec {
  kind: ExpectKind;
  target?: LocatorSpec;
  value?: string | number;
  /** var_equals / download_completed 需要引用的变量名。 */
  variable?: string;
}

// ---------------------------------------------------------------------------
// 流程步骤（FlowStep 联合类型）
// ---------------------------------------------------------------------------

export type ActionName =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'press'
  | 'select'
  | 'scroll'
  | 'wait'
  | 'screenshot'
  | 'upload';

export interface ActionStep {
  id: string;
  kind: 'action';
  action: ActionName;
  target?: LocatorSpec;
  /** 字面值；优先级低于 valuesRef。 */
  value?: string | number;
  /** 引用 values 中的 key（支持 secretRef 解析后的值，值不进入模型/日志）。 */
  /** 引用 values 中的 key（支持 secretRef 解析后的值，值不进入模型/日志）；
   *  values 缺失时回退到流程变量（forEach.itemVar / extract.saveAs）。 */
  valuesRef?: string;
  key?: string;
  expect: ExpectSpec[];
  /** upload 专用：待上传本地文件的绝对路径；
   *  必须位于 safety.allowedUploadDirs 之一（realpath 解析后前缀匹配，DESIGN §10）。 */
  filePath?: string;
}

export interface AssertStep {
  id: string;
  kind: 'assert';
  expect: ExpectSpec[];
}

export interface ExtractStep {
  id: string;
  kind: 'extract';
  target: LocatorSpec;
  fields: Array<'text' | 'count'>;
  saveAs: string;
}

/** 单层分支：不允许嵌套 branch（首版限制，DESIGN §8.1）。 */
export interface BranchStep {
  id: string;
  kind: 'branch';
  variable: string;
  equals: string | number;
  then: FlowStep[];
}

export interface ForEachStep {
  id: string;
  kind: 'forEach';
  /** 已提取的数组变量名。 */
  itemsVar: string;
  itemVar: string;
  maxItems: number;
  body: FlowStep[];
}

export interface GoalStep {
  id: string;
  kind: 'goal';
  goal: string;
  valuesRef?: string;
  expect: ExpectSpec[];
}

export type FlowStep = ActionStep | AssertStep | ExtractStep | BranchStep | ForEachStep | GoalStep;

/** values：JSON 值或 secretRef（值只在内存，DESIGN §6.3）。 */
export type SecretRef = { secretRef: string };
export type ValueInput = string | number | boolean | null | SecretRef;

export interface TaskBudget {
  maxSteps?: number;
  maxActions?: number;
  maxJevRequests?: number;
  maxPlannerRequests?: number;
  /** 绝对截止时间（epoch ms），只能比 taskTtl 更紧。 */
  deadlineAt?: number;
}

// ---------------------------------------------------------------------------
// 会话与任务输入
// ---------------------------------------------------------------------------

export type SessionTarget =
  | { kind: 'existing'; pageId?: string }
  | { kind: 'new'; url: string };

export interface CreateSessionInput {
  target: SessionTarget;
  /** 必须是宿主 allowedOrigins 的子集；空数组 = 仅允许当前页只读观察。 */
  allowedOrigins: string[];
  /** allowedOrigins 的子集：允许把页面摘要发给云模型。 */
  modelOrigins: string[];
}

export interface ExecuteTaskInput {
  sessionId: string;
  steps: FlowStep[];
  values?: Record<string, ValueInput>;
  budget?: TaskBudget;
}

export interface RunTaskInput {
  sessionId: string;
  goal: string;
  successCriteria: string;
  values?: Record<string, ValueInput>;
  budget?: TaskBudget;
}

export interface ActInput {
  sessionId: string;
  step: ActionStep;
  values?: Record<string, ValueInput>;
}

// ---------------------------------------------------------------------------
// 结果 envelope
// ---------------------------------------------------------------------------

export interface GoalVerification {
  /** 验证主体：代码断言 / Jev 语义 / 人工确认。 */
  by: 'deterministic' | 'semantic' | 'human';
  ok: boolean;
  detail?: string;
}

export interface StepResult {
  id: string;
  kind: FlowStep['kind'];
  status: 'done' | 'failed' | 'paused' | 'skipped';
  error?: { code: ErrorCode; message: string };
  savedAs?: string;
  artifactId?: string;
  iterations?: number;
  /** 步骤耗时（DESIGN §11 细粒度计时）。 */
  durationMs?: number;
  /** 脱敏证据（如执行后 URL、截图 artifactId）。 */
  evidence?: Record<string, unknown>;
}

export interface ArtifactMeta {
  artifactId: string;
  filename: string;
  size: number;
  sha256: string;
}

export interface PendingApproval {
  actionRevision: number;
  action: ActionName;
  targetName?: string;
  reason: string;
}

/** 能力探测（DESIGN §11）：未知/未实测能力不得标为 supported。 */
export type CapabilityId =
  | 'attach'
  | 'launch'
  | 'page-observation'
  | 'frame-access'
  | 'upload'
  | 'download'
  | 'dialog'
  | 'screenshot'
  | 'detach-preserves-browser'
  | 'artifact-save-after-disconnect'
  | 'profile-lock'
  | 'sandbox';

export type CapabilityState = 'supported' | 'unsupported' | 'unverified';

export interface CapabilityReport {
  id: CapabilityId;
  state: CapabilityState;
  detail?: string;
}

export interface TaskEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  taskId: string;
  sessionId: string;
  mode: 'execute' | 'run' | 'act';
  revision: number;
  status: TaskStatus;
  pauseReason?: PauseReason;
  stepResults: StepResult[];
  goalVerification?: GoalVerification;
  evidence?: Array<Record<string, unknown>>;
  metrics: {
    queuedMs: number;
    runningMs: number;
    actions: number;
    jevRequests: number;
    plannerRequests: number;
    /** 以下为可选细分（DESIGN §11）：连接耗时、token、模型实际版本、重规划次数。 */
    connectMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    jevModel?: string;
    plannerModel?: string;
    replans?: number;
  };
  error?: { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> };
  pendingApproval?: PendingApproval;
  artifacts: ArtifactMeta[];
}

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  pageId?: string;
  candidates?: PageCandidate[];
  allowedOrigins: string[];
  modelOrigins: string[];
}

export interface PageCandidate {
  pageId: string;
  title: string;
  /** 脱敏 URL：origin + 路径，去掉 query/fragment。 */
  url: string;
}
