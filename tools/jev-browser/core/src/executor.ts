import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionStep, ArtifactMeta, ExpectSpec, LocatorSpec } from './types.js';
import { ActionOutcomeUnknownError, JevError, err } from './errors.js';
import { resolveLocator, verifyExpects } from './locator.js';
import type { DialogManager } from './connectors.js';
import type { Clock, Logger, PagePort } from './ports.js';

/**
 * 动作执行器（DESIGN §6.4）：
 *  - 派发前 prepared → in_flight（由调用方记账），结果 verified/failed/unknown；
 *  - 超时 ≠ 未执行：TimeoutError 先核实后置状态，无法证实 → ActionOutcomeUnknownError；
 *  - 下载：先注册 download 等待再触发动作，saveAs 到受管 artifact 区（DESIGN §10 [S13]）。
 */

export interface LedgerHook {
  prepared(action: ActionStep, actionRevision: number): void;
  inFlight(action: ActionStep, actionRevision: number): void;
  finished(action: ActionStep, actionRevision: number, state: 'verified' | 'failed' | 'unknown', detail?: Record<string, unknown>): void;
}

export interface ArtifactSink {
  save(filename: string, data: Buffer): ArtifactMeta;
  saveDownload(filename: string, tmpPath: string): ArtifactMeta;
  dir(): string;
}

export class FsArtifactSink implements ArtifactSink {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  dir(): string {
    return this.root;
  }

  save(filename: string, data: Buffer): ArtifactMeta {
    const artifactId = newArtifactId();
    const safe = sanitizeFilename(filename);
    const full = path.join(this.root, `${artifactId}-${safe}`);
    fs.writeFileSync(full, data);
    return meta(artifactId, safe, full);
  }

  saveDownload(filename: string, tmpPath: string): ArtifactMeta {
    const artifactId = newArtifactId();
    const safe = sanitizeFilename(filename);
    const full = path.join(this.root, `${artifactId}-${safe}`);
    fs.copyFileSync(tmpPath, full);
    return meta(artifactId, safe, full);
  }
}

function newArtifactId(): string {
  return `a${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
  return base.length ? base.slice(0, 120) : 'download.bin';
}

function meta(artifactId: string, filename: string, full: string): ArtifactMeta {
  const data = fs.readFileSync(full);
  return {
    artifactId,
    filename,
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
}

export interface PerformContext {
  vars: Record<string, unknown>;
  values: Record<string, unknown>;
  artifacts: ArtifactSink;
  ledger: LedgerHook;
  actionRevision: number;
  actionTimeoutMs: number;
  /** 上传授权目录（DESIGN §10；空 = 拒绝一切上传）。 */
  allowedUploadDirs?: string[];
  /** 单文件上传大小上限（已知长度时预检，DESIGN §10）。 */
  maxUploadBytes?: number;
  /** 取消旗标：派发前检查；在途动作不中断（DESIGN §8.2 cancelling）。 */
  cancelFlag?: { cancelled: boolean };
  dialogs?: DialogManager;
  /** 已授权的 confirm 才允许接受（一次性）。 */
  acceptDialogOnce?: boolean;
}

export interface PerformResult {
  evidence: Record<string, unknown>;
  artifactId?: string;
}

export async function performAction(
  page: PagePort,
  step: ActionStep,
  ctx: PerformContext,
): Promise<PerformResult> {
  if (ctx.cancelFlag?.cancelled) {
    throw err('POLICY_BLOCKED', '任务已进入取消流程，动作未派发');
  }
  // 值解析在 prepared 之前：无法解析（缺 valuesRef/未解析 secretRef）时动作不派发
  const value = resolveValue(step, ctx.values, ctx.vars);
  if (step.action === 'navigate' && value === undefined) {
    throw err('INVALID_INPUT', 'navigate 动作需要 value 或 valuesRef 指定目标 URL');
  }
  // 上传文件安全检查在 prepared 之前：未授权文件动作不派发、不落账（DESIGN §10）
  if (step.action === 'upload') {
    await checkUploadFile(step, ctx);
  }
  ctx.ledger.prepared(step, ctx.actionRevision);
  const timeout = ctx.actionTimeoutMs;
  let downloadPromise: Promise</* DownloadPort */ import('./ports.js').DownloadPort> | undefined;
  // expect 仅对写操作强制（validateExecuteSteps）；只读动作合法地无 expect
  const wantsDownload = (step.expect ?? []).some((e) => e.kind === 'download_completed');

  try {
    ctx.ledger.inFlight(step, ctx.actionRevision);

    if (step.action === 'click' && wantsDownload) {
      // 先注册下载等待再触发（DESIGN §10 下载正确性）
      downloadPromise = page.waitForDownload({ timeout });
    }
    if (step.action === 'click' && ctx.acceptDialogOnce && ctx.dialogs) {
      ctx.dialogs.armOnce(page, '已授权的预期 confirm');
    }

    // 实测发现：screenshot 曾提前 return 绕过账本结算，动作永远留在 in_flight（重启后被标 unknown → 隔离）。
    // 现统一走尾部结算：各分支只产生 evidence/artifactId，由尾部统一 finished('verified')。
    let artifactId: string | undefined;
    let extraEvidence: Record<string, unknown> = {};
    switch (step.action) {
      case 'navigate': {
        await page.goto(String(value ?? ''), { timeout, waitUntil: 'load' });
        break;
      }
      case 'click': {
        const loc = requireTarget(page, step).first();
        await loc.click({ timeout });
        break;
      }
      case 'fill': {
        const loc = requireTarget(page, step).first();
        await loc.fill(String(value ?? ''), { timeout });
        break;
      }
      case 'press': {
        const key = step.key ?? 'Enter';
        if (step.target) {
          await resolveLocator(page, step.target).first().press(key, { timeout });
        } else {
          await page.keyboardPress(key);
        }
        break;
      }
      case 'select': {
        const loc = requireTarget(page, step).first();
        await loc.selectOption(String(value ?? ''), { timeout });
        break;
      }
      case 'scroll': {
        const px = Number(value ?? 600);
        await page.mouseWheel(0, Number.isFinite(px) ? px : 600);
        break;
      }
      case 'wait': {
        if (step.target) {
          await resolveLocator(page, step.target).first().waitFor('visible', { timeout });
        } else {
          await page.waitForTimeout(Math.min(Number(value ?? 1000), 5000));
        }
        break;
      }
      case 'upload': {
        const resolved = await checkUploadFile(step, ctx);
        const loc = requireTarget(page, step).first();
        await loc.setInputFiles([resolved], { timeout });
        break;
      }
      case 'evaluate': {
        // 用户已放开脚本执行限制：script 字段（或 value/valuesRef）中的 JS 直接在页面执行，无需审批
        const script = step.script ?? (value !== undefined ? String(value) : '');
        if (!script.trim()) {
          throw err('INVALID_INPUT', 'evaluate 需要非空 script（script 字段或 value/valuesRef）');
        }
        const result = await page.evaluate(script);
        let text: string;
        try {
          text = JSON.stringify(result) ?? String(result);
        } catch {
          text = String(result);
        }
        ctx.vars['lastEvaluate'] = text;
        extraEvidence = { evaluate: text.slice(0, 2000) };
        break;
      }
      case 'screenshot': {
        const buf = await page.screenshot({ fullPage: false });
        const art = ctx.artifacts.save(`shot-${Date.now()}.png`, buf);
        ctx.vars['lastArtifact'] = art.artifactId;
        artifactId = art.artifactId;
        extraEvidence = { screenshot: art.artifactId };
        break;
      }
      default: {
        const never: never = step.action;
        throw err('INVALID_INPUT', `未知动作: ${String(never)}`);
      }
    }

    if (downloadPromise) {
      const download = await downloadPromise;
      const suggested = download.suggestedFilename();
      const failure = await download.failure();
      if (failure) throw err('ACTION_FAILED', `下载失败: ${failure}`);
      // saveAs 到受管 artifact 区；临时路径绝不外泄（DESIGN §10 [S13]）
      const tmp = path.join(ctx.artifacts.dir(), `.tmp-${Date.now()}-${suggested}`);
      await download.saveAs(tmp);
      const art = ctx.artifacts.saveDownload(suggested, tmp);
      fs.rmSync(tmp, { force: true });
      artifactId = art.artifactId;
      ctx.vars['lastArtifact'] = artifactId;
    }

    const verdict = await verifyExpects(page, step.expect ?? [], { vars: ctx.vars, lastDownload: { artifactId } }, timeout);
    if (!verdict.ok) {
      ctx.ledger.finished(step, ctx.actionRevision, 'failed', { reason: 'postcondition', failures: verdict.failures });
      throw err('ACTION_FAILED', `后置条件未通过: ${verdict.failures.map((f) => f.reason).join('; ')}`.slice(0, 300), {
        details: { failures: verdict.failures },
      });
    }
    // 结果落账：verified/failed/unknown 三态必须收口（DESIGN §9.1）
    ctx.ledger.finished(step, ctx.actionRevision, 'verified', { url: page.url(), ...extraEvidence });
    return { evidence: { url: page.url(), ...extraEvidence }, artifactId };
  } catch (e) {
    if (e instanceof JevError && e.code === 'ACTION_FAILED' && (e.details as { failures?: unknown } | undefined)?.failures !== undefined) {
      throw e; // 后置条件失败已在上方落账，直接上抛
    }
    const isTimeout = /timeout|timed out/i.test((e as Error).message) || (e as { name?: string }).name === 'TimeoutError';
    if (isTimeout) {
      // 超时 ≠ 未执行：先核实后置状态（DESIGN §6.4）
      try {
        const verdict = await verifyExpects(page, step.expect ?? [], { vars: ctx.vars }, Math.min(timeout, 5000));
        if (verdict.ok) {
          ctx.ledger.finished(step, ctx.actionRevision, 'verified', { url: page.url(), verifiedAfterTimeout: true });
          return { evidence: { url: page.url(), verifiedAfterTimeout: true } };
        }
      } catch {
        // 核实本身失败：保持 unknown
      }
      ctx.ledger.finished(step, ctx.actionRevision, 'unknown', { reason: 'timeout' });
      throw new ActionOutcomeUnknownError(`动作超时且无法证实结果，已保持隔离: ${step.action}`, { stepId: step.id });
    }
    if (e instanceof ActionOutcomeUnknownError) throw e;
    const jev = e as { code?: string };
    if (jev?.code === 'POLICY_BLOCKED') throw e;
    if (jev?.code === 'INVALID_INPUT') throw e; // 未派发，无需落账失败结果
    ctx.ledger.finished(step, ctx.actionRevision, 'failed', { reason: (e as Error).message.slice(0, 200) });
    throw err('ACTION_FAILED', `动作 ${step.action} 失败: ${(e as Error).message.slice(0, 200)}`);
  }
}

/** 秘密文件默认拒绝（尽力而为的启发式，DESIGN §10）。 */
const UPLOAD_ABS_RE = /^[A-Za-z]:[\\/]|^\//;

/**
 * 上传文件检查（用户已放开目录白名单限制）：
 *  - 必须显式提供绝对路径（调用者显式授权具体文件）；
 *  - 任意路径均可上传（不再限制 allowedUploadDirs / 秘密文件启发式）；
 *  - 大小在已知长度时预检。
 * 未通过抛 POLICY_BLOCKED / INVALID_INPUT，动作不派发。
 */
export async function checkUploadFile(
  step: ActionStep,
  ctx: Pick<PerformContext, 'allowedUploadDirs' | 'maxUploadBytes'>,
): Promise<string> {
  const raw = step.filePath;
  if (!raw || !UPLOAD_ABS_RE.test(raw)) {
    throw err('INVALID_INPUT', `upload 需要绝对路径 filePath: ${String(raw ?? '')}`);
  }
  let st: fs.Stats;
  let real: string;
  try {
    st = fs.statSync(raw);
    real = fs.realpathSync(raw);
  } catch {
    throw err('INVALID_INPUT', `upload 文件不存在或不可读: ${raw}`);
  }
  if (!st.isFile()) throw err('INVALID_INPUT', `upload 目标不是常规文件: ${raw}`);
  const maxBytes = ctx.maxUploadBytes ?? 50 * 1024 * 1024;
  if (st.size > maxBytes) {
    throw err('POLICY_BLOCKED', `上传被拒绝：文件 ${st.size}B 超过上限 ${maxBytes}B（大小预检）`);
  }
  return real;
}

function requireTarget(page: PagePort, step: ActionStep) {
  if (!step.target) throw err('INVALID_INPUT', `动作 ${step.action} 需要 target`);
  return resolveLocator(page, step.target);
}

function resolveValue(step: ActionStep, values: Record<string, unknown>, vars?: Record<string, unknown>): string | number | undefined {
  if (step.valuesRef !== undefined) {
    let v: unknown = values[step.valuesRef];
    if (v === undefined && vars && step.valuesRef in vars) {
      // 回退到流程变量（如 forEach.itemVar / extract.saveAs）：页面数据可作为输入值，
      // 但仍是数据不是指令（DESIGN §10），且不包含 values/secret
      v = vars[step.valuesRef];
    }
    if (v === undefined) throw err('INVALID_INPUT', `valuesRef "${step.valuesRef}" 不存在于 values 或流程变量`);
    if (typeof v === 'object' && v !== null) {
      if ('secretRef' in v) throw err('INVALID_INPUT', `values["${step.valuesRef}"] 仍是未解析的 secretRef`);
      if (Array.isArray(v)) throw err('INVALID_INPUT', `valuesRef "${step.valuesRef}" 指向数组，动作输入需要标量`);
    }
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return v;
    return String(v);
  }
  return step.value;
}

export { requireTarget };

// ---- 重新导出以便复用 ----
export type { ExpectSpec, LocatorSpec };
