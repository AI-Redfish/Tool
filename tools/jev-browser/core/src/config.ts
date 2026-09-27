import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { err } from './errors.js';

/**
 * 配置（DESIGN §5）：来源优先级 CLI 覆盖 > 环境变量 > JSON 文件 > 默认值。
 * 严格校验：未知字段报错；布尔只接受 true/false/1/0；modelOrigins ⊆ allowedOrigins。
 * attach 与 launch 分支并存，仅激活当前 mode 的分支（不因另一分支存在而报冲突）。
 */

export interface BrowserAttachConfig {
  endpoint: string;
  noDefaults: boolean;
  timeoutMs: number;
}

export interface BrowserLaunchConfig {
  userDataDir?: string;
  timeoutMs: number;
  chromiumSandbox: boolean;
}

export interface JevConfig {
  model: string;
  apiKeyEnv: string;
  /** done 判定阈值与确认带（dev 初值，须按业务校准，DESIGN §6.3）。 */
  doneAt: number;
  confirmLow: number;
  confirmHigh: number;
  blockedAt: number;
  errorAt: number;
  targetConfidenceAt: number;
}

export interface PlannerConfig {
  enabled: boolean;
  provider?: 'openai-compatible';
  baseUrl?: string;
  model?: string;
  apiKeyEnv: string;
  timeoutMs: number;
}

export interface RuntimeConfig {
  dataDir: string;
  /** 任务累计自动执行时间（不含排队/人工暂停）。 */
  timeoutMs: number;
  maxSteps: number;
  maxActions: number;
  maxReplans: number;
  maxJevRequests: number;
  maxPlannerRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  queueTimeoutMs: number;
  pauseTtlMs: number;
  taskTtlMs: number;
  /** 单动作超时（dispatch 后的 Playwright timeout 上限）。 */
  actionTimeoutMs: number;
}

export interface SafetyConfig {
  allowedOrigins: string[];
  modelOrigins: string[];
  approvalTtlMs: number;
  /** 预授权动作白名单（不在名单内的动作一律暂停）。 */
  preauthorizedActions: string[];
  /** 高风险目标名 pattern（命中即需要确认，如 支付/购买/删除/发送）。 */
  riskyNamePatterns: string[];
  /** 上传授权目录（绝对路径；空数组 = 拒绝一切上传，DESIGN §10：须授权具体文件）。 */
  allowedUploadDirs: string[];
  /** 单文件上传大小上限（字节，已知长度时预检）。 */
  maxUploadBytes: number;
}

export interface ApiConfig {
  host: string;
  port: number;
  tokenEnv: string;
  /** 每 token 每分钟写请求上限（DESIGN §10：限定速率；0 = 不限）。 */
  rateLimitPerMin: number;
  /** 同时在途请求上限（DESIGN §10：限定并发；超出返回 429）。 */
  maxConcurrentRequests: number;
}

export interface JevBrowserConfig {
  schemaVersion: 1;
  browser: {
    mode: 'attach' | 'launch';
    engine: 'chrome' | 'chromium';
    headless: boolean;
    attach: BrowserAttachConfig;
    launch: BrowserLaunchConfig;
  };
  jev: JevConfig;
  planner: PlannerConfig;
  runtime: RuntimeConfig;
  safety: SafetyConfig;
  api: ApiConfig;
}

export type ConfigOverrides = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'AI-Redfish', 'jev-browser');
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'jev-browser');
}

export function defaultUserConfigFile(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'AI-Redfish', 'jev-browser', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'jev-browser', 'config.json');
}

export function defaultConfig(): JevBrowserConfig {
  return {
    schemaVersion: 1,
    browser: {
      mode: 'attach',
      engine: 'chrome',
      headless: false,
      attach: { endpoint: 'chrome', noDefaults: true, timeoutMs: 60_000 },
      launch: { timeoutMs: 30_000, chromiumSandbox: true },
    },
    jev: {
      model: 'jev-latest',
      apiKeyEnv: 'TYPESAFE_API_KEY',
      doneAt: 0.85,
      confirmLow: 0.5,
      confirmHigh: 0.85,
      blockedAt: 0.7,
      errorAt: 0.7,
      targetConfidenceAt: 0.6,
    },
    planner: { enabled: false, apiKeyEnv: 'JEV_BROWSER_PLANNER_API_KEY', timeoutMs: 60_000 },
    runtime: {
      dataDir: defaultDataDir(),
      timeoutMs: 180_000,
      maxSteps: 100,
      maxActions: 60,
      maxReplans: 3,
      maxJevRequests: 100,
      maxPlannerRequests: 8,
      maxInputTokens: 200_000,
      maxOutputTokens: 20_000,
      queueTimeoutMs: 60_000,
      pauseTtlMs: 900_000,
      taskTtlMs: 1_800_000,
      actionTimeoutMs: 15_000,
    },
    safety: {
      allowedOrigins: [],
      modelOrigins: [],
      approvalTtlMs: 120_000,
      preauthorizedActions: ['navigate', 'scroll', 'wait', 'screenshot', 'fill', 'press', 'select', 'click', 'upload'],
      riskyNamePatterns: [
        '支付', '付款', '购买', '下单', '结算', '删除', '发送', '提交订单', '确认订单',
        'pay', 'checkout', 'purchase', 'delete', 'remove', 'send', 'place order',
      ],
      // 默认无授权目录 = 拒绝一切上传（显式配置目录后，具体文件路径即显式授权，DESIGN §10）
      allowedUploadDirs: [],
      maxUploadBytes: 50 * 1024 * 1024,
    },
    api: { host: '127.0.0.1', port: 3737, tokenEnv: 'JEV_BROWSER_API_TOKEN', rateLimitPerMin: 120, maxConcurrentRequests: 16 },
  };
}

// ---------------------------------------------------------------------------
// 严格合并
// ---------------------------------------------------------------------------

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 可选字段（不在默认值对象中，但配置文件/覆盖允许提供）。 */
const OPTIONAL_FIELDS = new Set([
  'browser.launch.userDataDir',
  'planner.provider',
  'planner.baseUrl',
  'planner.model',
]);

/** 以 template 的键为准：未知键报错；标量类型必须与默认值一致；数组与对象递归。 */
function mergeInto(target: Plain, patch: Plain, template: Plain, where: string, prefix = ''): void {
  for (const [k, v] of Object.entries(patch)) {
    const fieldPath = prefix ? `${prefix}.${k}` : k;
    if (!(k in template)) {
      if (OPTIONAL_FIELDS.has(fieldPath)) {
        if (typeof v !== 'string') throw err('CONFIG_INVALID', `${fieldPath}: 需要 string，得到 ${typeof v}`);
        target[k] = v;
        continue;
      }
      throw err('CONFIG_INVALID', `${where}: 未知字段 "${k}"`);
    }
    const tv = template[k];
    if (isPlainObject(v) && isPlainObject(tv)) {
      mergeInto(target[k] as Plain, v, tv, `${where}.${k}`, fieldPath);
    } else if (isPlainObject(v) || Array.isArray(v) && isPlainObject(tv)) {
      throw err('CONFIG_INVALID', `${where}.${k}: 类型错误`);
    } else if (Array.isArray(tv)) {
      if (!Array.isArray(v)) throw err('CONFIG_INVALID', `${where}.${k}: 需要数组`);
      target[k] = v;
    } else if (typeof v !== typeof tv) {
      throw err('CONFIG_INVALID', `${where}.${k}: 需要 ${typeof tv}，得到 ${typeof v}`);
    } else {
      target[k] = v;
    }
  }
}

const ENV_BOOL = new Set(['true', 'false', '1', '0']);

function parseBool(where: string, v: string): boolean {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw err('CONFIG_INVALID', `${where}: 布尔只接受 true/false/1/0，得到 "${v}"`);
}

function parseJsonArray(where: string, v: string): string[] {
  try {
    const parsed: unknown = JSON.parse(v);
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) throw new Error('not string[]');
    return parsed as string[];
  } catch {
    throw err('CONFIG_INVALID', `${where}: 需要字符串数组的 JSON，如 '["https://example.com"]'`);
  }
}

function applyEnv(cfg: JevBrowserConfig, env: NodeJS.ProcessEnv): void {
  const get = (k: string) => env[k];
  const setNum = (obj: Plain, key: string, envKey: string) => {
    const v = get(envKey);
    if (v === undefined || v === '') return;
    const n = Number(v);
    if (!Number.isFinite(n)) throw err('CONFIG_INVALID', `${envKey}: 需要数字`);
    obj[key] = n;
  };
  const mode = get('JEV_BROWSER_MODE');
  if (mode !== undefined && mode !== '') {
    if (mode !== 'attach' && mode !== 'launch') throw err('CONFIG_INVALID', `JEV_BROWSER_MODE: ${mode}`);
    cfg.browser.mode = mode;
  }
  const engine = get('JEV_BROWSER_ENGINE');
  if (engine !== undefined && engine !== '') {
    if (engine !== 'chrome' && engine !== 'chromium') throw err('CONFIG_INVALID', `JEV_BROWSER_ENGINE: ${engine}`);
    cfg.browser.engine = engine;
  }
  const headless = get('JEV_BROWSER_HEADLESS');
  if (headless !== undefined && headless !== '') cfg.browser.headless = parseBool('JEV_BROWSER_HEADLESS', headless);
  const attach = cfg.browser.attach as unknown as Plain;
  const endpoint = get('JEV_BROWSER_CDP_ENDPOINT');
  if (endpoint) attach.endpoint = endpoint;
  const noDef = get('JEV_BROWSER_NO_DEFAULTS');
  if (noDef !== undefined && noDef !== '') attach.noDefaults = parseBool('JEV_BROWSER_NO_DEFAULTS', noDef);
  setNum(attach, 'timeoutMs', 'JEV_BROWSER_CONNECT_TIMEOUT_MS');
  const launch = cfg.browser.launch as unknown as Plain;
  const udd = get('JEV_BROWSER_USER_DATA_DIR');
  if (udd) {
    if (!path.isAbsolute(udd)) throw err('CONFIG_INVALID', 'JEV_BROWSER_USER_DATA_DIR: 需要绝对路径');
    launch.userDataDir = udd;
  }
  setNum(launch, 'timeoutMs', 'JEV_BROWSER_LAUNCH_TIMEOUT_MS');
  const sandbox = get('JEV_BROWSER_CHROMIUM_SANDBOX');
  if (sandbox !== undefined && sandbox !== '') launch.chromiumSandbox = parseBool('JEV_BROWSER_CHROMIUM_SANDBOX', sandbox);

  const jev = cfg.jev as unknown as Plain;
  const jevModel = get('JEV_BROWSER_JEV_MODEL');
  if (jevModel) jev.model = jevModel;
  const jevKeyEnv = get('JEV_BROWSER_JEV_API_KEY_ENV');
  if (jevKeyEnv) jev.apiKeyEnv = jevKeyEnv;

  const planner = cfg.planner as unknown as Plain;
  const pEnabled = get('JEV_BROWSER_PLANNER_ENABLED');
  if (pEnabled !== undefined && pEnabled !== '') planner.enabled = parseBool('JEV_BROWSER_PLANNER_ENABLED', pEnabled);
  const pProvider = get('JEV_BROWSER_PLANNER_PROVIDER');
  if (pProvider) {
    if (pProvider !== 'openai-compatible') throw err('CONFIG_INVALID', `JEV_BROWSER_PLANNER_PROVIDER: 暂只支持 openai-compatible`);
    planner.provider = pProvider;
  }
  const pBase = get('JEV_BROWSER_PLANNER_BASE_URL');
  if (pBase) planner.baseUrl = pBase;
  const pModel = get('JEV_BROWSER_PLANNER_MODEL');
  if (pModel) planner.model = pModel;
  const pKeyEnv = get('JEV_BROWSER_PLANNER_API_KEY_ENV');
  if (pKeyEnv) planner.apiKeyEnv = pKeyEnv;
  setNum(planner, 'timeoutMs', 'JEV_BROWSER_PLANNER_TIMEOUT_MS');

  const rt = cfg.runtime as unknown as Plain;
  const rData = get('JEV_BROWSER_DATA_DIR');
  if (rData) {
    if (!path.isAbsolute(rData)) throw err('CONFIG_INVALID', 'JEV_BROWSER_DATA_DIR: 需要绝对路径');
    rt.dataDir = rData;
  }
  setNum(rt, 'timeoutMs', 'JEV_BROWSER_TIMEOUT_MS');
  setNum(rt, 'maxSteps', 'JEV_BROWSER_MAX_STEPS');
  setNum(rt, 'maxActions', 'JEV_BROWSER_MAX_ACTIONS');
  setNum(rt, 'maxReplans', 'JEV_BROWSER_MAX_REPLANS');
  setNum(rt, 'maxJevRequests', 'JEV_BROWSER_MAX_JEV_REQUESTS');
  setNum(rt, 'maxPlannerRequests', 'JEV_BROWSER_MAX_PLANNER_REQUESTS');
  setNum(rt, 'maxInputTokens', 'JEV_BROWSER_MAX_INPUT_TOKENS');
  setNum(rt, 'maxOutputTokens', 'JEV_BROWSER_MAX_OUTPUT_TOKENS');
  setNum(rt, 'queueTimeoutMs', 'JEV_BROWSER_QUEUE_TIMEOUT_MS');
  setNum(rt, 'pauseTtlMs', 'JEV_BROWSER_PAUSE_TTL_MS');
  setNum(rt, 'taskTtlMs', 'JEV_BROWSER_TASK_TTL_MS');
  setNum(rt, 'actionTimeoutMs', 'JEV_BROWSER_ACTION_TIMEOUT_MS');

  const safety = cfg.safety as unknown as Plain;
  const allowed = get('JEV_BROWSER_ALLOWED_ORIGINS');
  if (allowed !== undefined && allowed !== '') safety.allowedOrigins = parseJsonArray('JEV_BROWSER_ALLOWED_ORIGINS', allowed);
  const modelOrigins = get('JEV_BROWSER_MODEL_ORIGINS');
  if (modelOrigins !== undefined && modelOrigins !== '') safety.modelOrigins = parseJsonArray('JEV_BROWSER_MODEL_ORIGINS', modelOrigins);
  setNum(safety, 'approvalTtlMs', 'JEV_BROWSER_APPROVAL_TTL_MS');

  const safety2 = cfg.safety as unknown as Plain;
  const uploadDirs = get('JEV_BROWSER_ALLOWED_UPLOAD_DIRS');
  if (uploadDirs !== undefined && uploadDirs !== '') {
    const dirs = parseJsonArray('JEV_BROWSER_ALLOWED_UPLOAD_DIRS', uploadDirs);
    for (const d of dirs) {
      if (!path.isAbsolute(d)) throw err('CONFIG_INVALID', `JEV_BROWSER_ALLOWED_UPLOAD_DIRS: 需要绝对路径: ${d}`);
    }
    safety2.allowedUploadDirs = dirs;
  }
  const maxUpload = get('JEV_BROWSER_MAX_UPLOAD_BYTES');
  if (maxUpload !== undefined && maxUpload !== '') {
    const n = Number(maxUpload);
    if (!Number.isFinite(n) || n <= 0) throw err('CONFIG_INVALID', 'JEV_BROWSER_MAX_UPLOAD_BYTES: 需要正数');
    safety2.maxUploadBytes = n;
  }

  const api = cfg.api as unknown as Plain;
  const rateLimit = get('JEV_BROWSER_API_RATE_LIMIT_PER_MIN');
  if (rateLimit !== undefined && rateLimit !== '') {
    const n = Number(rateLimit);
    if (!Number.isFinite(n) || n < 0) throw err('CONFIG_INVALID', 'JEV_BROWSER_API_RATE_LIMIT_PER_MIN: 需要非负数');
    api.rateLimitPerMin = n;
  }
  const maxConc = get('JEV_BROWSER_API_MAX_CONCURRENT');
  if (maxConc !== undefined && maxConc !== '') {
    const n = Number(maxConc);
    if (!Number.isFinite(n) || n < 1) throw err('CONFIG_INVALID', 'JEV_BROWSER_API_MAX_CONCURRENT: 需要正整数');
    api.maxConcurrentRequests = n;
  }
  const host = get('JEV_BROWSER_API_HOST');
  if (host) {
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      throw err('CONFIG_INVALID', 'JEV_BROWSER_API_HOST: 首版只接受 loopback');
    }
    api.host = host === 'localhost' ? '127.0.0.1' : host;
  }
  setNum(api, 'port', 'JEV_BROWSER_API_PORT');
  const tokenEnv = get('JEV_BROWSER_API_TOKEN_ENV');
  if (tokenEnv) api.tokenEnv = tokenEnv;
}

function validateFinal(cfg: JevBrowserConfig): void {
  if (cfg.browser.mode === 'attach' && cfg.browser.headless) {
    throw err('CONFIG_INVALID', 'attach + headless=true 不支持：无头是启动属性，已运行的有头 Chrome 不能切换；请显式 browser.mode=launch');
  }
  if (cfg.browser.mode === 'attach' && cfg.browser.engine !== 'chrome') {
    throw err('CONFIG_INVALID', 'attach + chromium 首版不支持：接管管理 Chromium 请显式 mode=launch');
  }
  if (cfg.safety.modelOrigins.some((o) => !cfg.safety.allowedOrigins.includes(o))) {
    throw err('CONFIG_INVALID', 'safety.modelOrigins 必须是 safety.allowedOrigins 的子集');
  }
  const originRe = /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i;
  for (const o of [...cfg.safety.allowedOrigins, ...cfg.safety.modelOrigins]) {
    if (!originRe.test(o)) throw err('CONFIG_INVALID', `safety origin 非法（只允许明确的 http/https origin）: "${o}"`);
  }
  if (cfg.browser.mode === 'attach') {
    const ep = cfg.browser.attach.endpoint;
    if (ep !== 'chrome') {
      if (!/^https?:\/\//i.test(ep)) {
        throw err('CONFIG_INVALID', `browser.attach.endpoint 只支持 "chrome" 或 http(s) URL: "${ep}"`);
      }
      let u: URL;
      try {
        u = new URL(ep);
      } catch {
        throw err('CONFIG_INVALID', `browser.attach.endpoint 不是合法 URL: "${ep}"`);
      }
      if (!/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(u.hostname)) {
        throw err('CONFIG_INVALID', `browser.attach.endpoint 只允许 loopback（DESIGN §4.1）: ${u.hostname}`);
      }
    }
  }
  if (cfg.browser.mode === 'launch' && cfg.browser.launch.userDataDir && !path.isAbsolute(cfg.browser.launch.userDataDir)) {
    throw err('CONFIG_INVALID', 'browser.launch.userDataDir 需要绝对路径');
  }
  if (cfg.planner.enabled) {
    if (!cfg.planner.provider || !cfg.planner.baseUrl || !cfg.planner.model) {
      throw err('CONFIG_INVALID', 'planner.enabled=true 时需要 provider/baseUrl/model（无默认厂商，DESIGN §7）');
    }
    if (cfg.planner.provider !== 'openai-compatible') {
      throw err('CONFIG_INVALID', `planner.provider 暂只支持 openai-compatible: ${cfg.planner.provider}`);
    }
    if (!/^https?:\/\//i.test(cfg.planner.baseUrl)) {
      throw err('CONFIG_INVALID', `planner.baseUrl 必须是 http(s) URL: ${cfg.planner.baseUrl}`);
    }
  }
  // 数值合理性：时限/预算必须为正（配置文件来源的字段在此兜底）
  const positive: Array<[number, string]> = [
    [cfg.browser.attach.timeoutMs, 'browser.attach.timeoutMs'],
    [cfg.browser.launch.timeoutMs, 'browser.launch.timeoutMs'],
    [cfg.jev.doneAt, 'jev.doneAt'],
    [cfg.runtime.timeoutMs, 'runtime.timeoutMs'],
    [cfg.runtime.maxSteps, 'runtime.maxSteps'],
    [cfg.runtime.maxActions, 'runtime.maxActions'],
    [cfg.runtime.maxJevRequests, 'runtime.maxJevRequests'],
    [cfg.runtime.maxPlannerRequests, 'runtime.maxPlannerRequests'],
    [cfg.runtime.queueTimeoutMs, 'runtime.queueTimeoutMs'],
    [cfg.runtime.pauseTtlMs, 'runtime.pauseTtlMs'],
    [cfg.runtime.taskTtlMs, 'runtime.taskTtlMs'],
    [cfg.runtime.actionTimeoutMs, 'runtime.actionTimeoutMs'],
    [cfg.safety.approvalTtlMs, 'safety.approvalTtlMs'],
  ];
  for (const [v, name] of positive) {
    if (!Number.isFinite(v) || v <= 0) throw err('CONFIG_INVALID', `${name} 必须为正数: ${v}`);
  }
  for (const [v, name] of [[cfg.jev.doneAt, 'jev.doneAt'], [cfg.jev.confirmLow, 'jev.confirmLow'], [cfg.jev.confirmHigh, 'jev.confirmHigh']] as Array<[number, string]>) {
    if (v < 0.5 || v > 1) throw err('CONFIG_INVALID', `${name} 应在 0.5..1 之间: ${v}`);
  }
  if (cfg.api.port < 1 || cfg.api.port > 65535) throw err('CONFIG_INVALID', `api.port 非法: ${cfg.api.port}`);
}

export interface LoadedConfig {
  config: JevBrowserConfig;
  sources: { file?: string; envKeys: string[] };
}

export interface LoadConfigOptions {
  /** CLI --config 显式路径；存在则必须可用。 */
  file?: string;
  env?: NodeJS.ProcessEnv;
  /** CLI 覆盖（已解析的对象，仍走严格合并）。 */
  overrides?: ConfigOverrides;
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const cfg = defaultConfig();
  const sources: LoadedConfig['sources'] = { envKeys: [] };

  // 1) 文件：--config > JEV_BROWSER_CONFIG > 用户配置目录
  let file = opts.file;
  let fileExplicit = Boolean(file);
  if (!file) file = env.JEV_BROWSER_CONFIG || undefined;
  if (!file && fs.existsSync(defaultUserConfigFile())) file = defaultUserConfigFile();
  if (file) {
    if (!fs.existsSync(file)) {
      if (fileExplicit) throw err('CONFIG_INVALID', `配置文件不存在: ${file}`);
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw err('CONFIG_INVALID', `配置文件 JSON 解析失败: ${file}: ${(e as Error).message}`);
      }
      if (!isPlainObject(parsed)) throw err('CONFIG_INVALID', `配置文件顶层必须是对象: ${file}`);
      mergeInto(cfg as unknown as Plain, parsed, defaultConfig() as unknown as Plain, 'file');
      sources.file = file;
    }
  }

  // 2) 环境变量
  const envKeys = [
    'JEV_BROWSER_MODE', 'JEV_BROWSER_ENGINE', 'JEV_BROWSER_HEADLESS', 'JEV_BROWSER_CDP_ENDPOINT',
    'JEV_BROWSER_NO_DEFAULTS', 'JEV_BROWSER_CONNECT_TIMEOUT_MS', 'JEV_BROWSER_USER_DATA_DIR',
    'JEV_BROWSER_LAUNCH_TIMEOUT_MS', 'JEV_BROWSER_CHROMIUM_SANDBOX', 'JEV_BROWSER_JEV_MODEL',
    'JEV_BROWSER_JEV_API_KEY_ENV', 'JEV_BROWSER_PLANNER_ENABLED', 'JEV_BROWSER_PLANNER_PROVIDER',
    'JEV_BROWSER_PLANNER_BASE_URL', 'JEV_BROWSER_PLANNER_MODEL', 'JEV_BROWSER_PLANNER_API_KEY_ENV',
    'JEV_BROWSER_PLANNER_TIMEOUT_MS', 'JEV_BROWSER_DATA_DIR', 'JEV_BROWSER_TIMEOUT_MS',
    'JEV_BROWSER_MAX_STEPS', 'JEV_BROWSER_MAX_ACTIONS', 'JEV_BROWSER_MAX_REPLANS',
    'JEV_BROWSER_MAX_JEV_REQUESTS', 'JEV_BROWSER_MAX_PLANNER_REQUESTS', 'JEV_BROWSER_MAX_INPUT_TOKENS',
    'JEV_BROWSER_MAX_OUTPUT_TOKENS', 'JEV_BROWSER_QUEUE_TIMEOUT_MS', 'JEV_BROWSER_PAUSE_TTL_MS',
    'JEV_BROWSER_TASK_TTL_MS', 'JEV_BROWSER_ACTION_TIMEOUT_MS', 'JEV_BROWSER_ALLOWED_ORIGINS',
    'JEV_BROWSER_MODEL_ORIGINS', 'JEV_BROWSER_APPROVAL_TTL_MS', 'JEV_BROWSER_API_HOST',
    'JEV_BROWSER_API_PORT', 'JEV_BROWSER_API_TOKEN_ENV', 'JEV_BROWSER_ALLOWED_UPLOAD_DIRS',
    'JEV_BROWSER_MAX_UPLOAD_BYTES', 'JEV_BROWSER_API_RATE_LIMIT_PER_MIN', 'JEV_BROWSER_API_MAX_CONCURRENT',
  ];
  for (const k of envKeys) {
    const v = env[k];
    if (v !== undefined && v !== '') sources.envKeys.push(k);
  }
  applyEnv(cfg, env);

  // 3) CLI 覆盖
  if (opts.overrides) {
    mergeInto(cfg as unknown as Plain, opts.overrides, defaultConfig() as unknown as Plain, 'overrides');
  }

  // 4) 相对路径按配置文件所在目录解析（DESIGN §5.1）；须在最终校验前完成
  if (sources.file) {
    const base = path.dirname(sources.file);
    if (cfg.browser.launch.userDataDir && !path.isAbsolute(cfg.browser.launch.userDataDir)) {
      cfg.browser.launch.userDataDir = path.resolve(base, cfg.browser.launch.userDataDir);
    }
    if (!path.isAbsolute(cfg.runtime.dataDir)) {
      cfg.runtime.dataDir = path.resolve(base, cfg.runtime.dataDir);
    }
  }

  validateFinal(cfg);

  return { config: cfg, sources };
}

/** doctor 用：脱敏展示（绝不打印 secret 值）。 */
export function redactForDoctor(cfg: JevBrowserConfig): Plain {
  const clone = JSON.parse(JSON.stringify(cfg)) as Plain;
  const jev = clone.jev as Plain;
  jev.apiKeyEnv = String(jev.apiKeyEnv);
  const planner = clone.planner as Plain;
  planner.apiKeyEnv = String(planner.apiKeyEnv);
  const api = clone.api as Plain;
  api.tokenEnv = String(api.tokenEnv);
  return clone;
}

/** Jev / 规划器 / API token 的密钥是否存在（不读取值以外的东西）。 */
export function credentialPresent(cfg: JevBrowserConfig, kind: 'jev' | 'planner' | 'api', env: NodeJS.ProcessEnv = process.env): boolean {
  const name = kind === 'jev' ? cfg.jev.apiKeyEnv : kind === 'planner' ? cfg.planner.apiKeyEnv : cfg.api.tokenEnv;
  const v = env[name];
  return typeof v === 'string' && v.length > 0;
}
