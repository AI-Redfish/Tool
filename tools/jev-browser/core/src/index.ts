/**
 * @ai-redfish/jev-browser-core —— 公共 API
 *
 * 分层（DESIGN §3）：core 只提供能力与工具元数据；cli/mcp/api 是薄适配器。
 * 浏览器通过端口注入（ports.ts），playwright 只在 connectors.ts 出现。
 */

export * from './types.js';
export { JevError, ActionOutcomeUnknownError, PauseSignal, err } from './errors.js';
export {
  loadConfig,
  defaultConfig,
  defaultDataDir,
  defaultUserConfigFile,
  credentialPresent,
  redactForDoctor,
  type JevBrowserConfig,
  type LoadConfigOptions,
  type LoadedConfig,
} from './config.js';
export { PolicyGate, originOf, isOriginAllowed, targetLooksRisky } from './policy.js';
export { assertTransition, canTransition, resolveCancelling, recoverStale } from './statemachine.js';
export { signGrant, verifyGrant, type GrantPayload } from './grants.js';
export { TaskStore, type TaskRow, type SessionRow, type ArtifactRow } from './store.js';
export {
  PlaywrightConnector, selectPage, DialogManager,
} from './connectors.js';
export type {
  BrowserPort, ContextPort, PagePort, LocatorPort, DownloadPort, DialogPort,
  BrowserConnector, Clock, Logger,
} from './ports.js';
export { consoleLogger, systemClock, redactUrl } from './ports.js';
export { resolveAttachEndpoint, discoverChromeLoopbackEndpoint } from './connectors.js';
export {
  prepareChromeDebug, probeCdp, findChromeExecutable, chromeExecutableCandidates,
  defaultChromeDebugUserDataDir, saveAttachEndpointToUserConfig, ensureDebugChromeAt,
  autoLaunchDebugChromeEnabled, DEFAULT_CHROME_DEBUG_PORT,
  type ChromeDebugOptions, type ChromeDebugResult, type CdpProbe,
} from './chromedebug.js';
export {
  observePage, diffObservation, waitForSettle, slimObservation, renderObservation,
  MAX_ELEMENTS_DEFAULT, MAX_ELEMENTS_CAP,
  type PageObservation, type ObservedElement, type ObserveOptions,
} from './observe.js';
export { resolveLocator, verifyExpects, evidenceUrl } from './locator.js';
export { pollNewPages } from './pagetrack.js';
export { expandShorthandSteps } from './shorthand.js';
export { TypeSafeJudge, GOAL_ACTIONS, scopeCandidates, type JudgePort, type RoundDecision, type GoalAction } from './judge.js';
export { OpenAICompatibleProvider, WRITE_ACTIONS, validatePlannedSteps, type PlannerProvider, type PlannerInput } from './planner.js';
export { performAction, FsArtifactSink, type ArtifactSink, type LedgerHook, type PerformContext } from './executor.js';
export { FlowExecutor, type FlowRunContext, type FlowRunResult, type GoalRunner } from './flow.js';
export { GoalExecutor, type GoalLoopOptions } from './goal.js';
export {
  Runtime, validateExecuteSteps, resolveValues,
  type SubmitOptions, type ResumeOptions, type CancelOptions,
} from './taskservice.js';
export { runDoctor, type DoctorResult } from './doctor.js';
export { RateLimiter } from './ratelimit.js';
export { ApiClient } from './httpclient.js';

/** 工具元数据（MCP 注册与 CLI help 的单一事实来源，沿用仓库 TOOLS 约定）。 */
export interface ToolMeta {
  name: string;
  description: string;
  /** 风险标签（DESIGN §3：TOOLS 携带风险标签）。 */
  risk: 'readonly' | 'write' | 'control';
}

export const SERVER_NAME = 'jev-browser';
export const SERVER_VERSION = '0.1.0';

export const TOOLS: ToolMeta[] = [
  { name: 'browser_doctor', description: '诊断环境与配置（可选：尝试连接日常 Chrome，需授权）', risk: 'readonly' },
  { name: 'browser_connect', description: '创建会话：绑定目标标签页/新页，并声明 allowedOrigins/modelOrigins（默认不许可任何网站）', risk: 'control' },
  { name: 'browser_pages', description: '列出会话可见的标签页（脱敏 URL）', risk: 'readonly' },
  { name: 'browser_select_page', description: '选择/切换会话绑定的标签页', risk: 'control' },
  { name: 'browser_execute', description: '执行确定性步骤序列（action/assert/extract；支持一行式简写步骤；写操作需后置条件；不调用规划模型；默认附 afterObservation 并跟踪/跟随新开标签页）', risk: 'write' },
  { name: 'browser_run', description: '执行完整目标（内部规划器拆解为步骤；需配置 planner 与 successCriteria）', risk: 'write' },
  { name: 'browser_snapshot', description: '只读页面快照（默认仅视口内元素、上限 200；filter 按 name 子串、roles 按角色收窄；forModel 只回紧凑文本行且需 origin ∈ modelOrigins）', risk: 'readonly' },
  { name: 'browser_act', description: '单步动作（支持简写字符串；受同一策略/预算/审批约束；默认附 afterObservation 并跟踪新开标签页）', risk: 'write' },
  { name: 'browser_task_get', description: '查询任务状态（envelope）', risk: 'readonly' },
  { name: 'browser_task_cancel', description: '取消任务（requestId + expectedRevision）', risk: 'control' },
  { name: 'browser_task_resume', description: '恢复暂停任务（requestId + expectedRevision；未知结果需 rerunConfirmed）', risk: 'control' },
  { name: 'browser_task_approve', description: '核验并登记审批 grant（不执行动作；派发前才消费）', risk: 'control' },
  { name: 'browser_artifact_get', description: '取回任务产物（下载文件/截图）的元信息与路径', risk: 'readonly' },
  { name: 'browser_disconnect', description: '断开会话（活动任务会拒绝；暂停任务需显式 detachTask）', risk: 'control' },
  { name: 'browser_judge', description: '单问题语义判断：把「当前页是否满足某条件」交给 Jev 打分（0~1），一句话顶一屏元素；需 origin ∈ modelOrigins', risk: 'readonly' },
];
