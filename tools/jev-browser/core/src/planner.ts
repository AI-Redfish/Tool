import path from 'node:path';
import type { ActionStep, FlowStep } from './types.js';
import { err } from './errors.js';
import type { PlannerConfig } from './config.js';

/**
 * 可选规划器（DESIGN §7 / P4）：`run` 模式由它把完整目标拆成受 schema 校验的 FlowStep。
 * 首个 Provider 为 openai-compatible（用户显式配置 baseUrl/model/keyEnv；无默认厂商）。
 * P4 退出门槛要求实现前核对真实服务协议；本实现标注为需 P4 联调验证。
 */

export interface PlannerInput {
  goal: string;
  successCriteria: string;
  valuesKeys: string[];
  allowedOrigins: string[];
  currentUrl?: string;
}

export interface PlannerProvider {
  plan(input: PlannerInput): Promise<FlowStep[]>;
  /** 重规划（DESIGN §7）：只生成未完成后缀；保留已完成步骤由调用方负责。 */
  replan?(input: PlannerInput & { completedStepIds: string[]; pausedReason: string }): Promise<FlowStep[]>;
  /** 已消耗的请求与 token（DESIGN §6.4 预算/DESIGN §11 可观测）。 */
  usage?(): { requests: number; inputTokens: number; outputTokens: number; model?: string };
}

const STEP_LIMIT = 30;

function systemPrompt(): string {
  return [
    '你是浏览器自动化任务规划器。把目标和验收条件拆成严格的 JSON 步骤数组。',
    '输出 JSON：{"steps": FlowStep[]}。FlowStep 的 kind 只能是 action|assert|extract|branch|forEach|goal。',
    '规则：',
    '1. action.action 只能是 navigate|click|fill|press|select|scroll|wait|screenshot。',
    '2. LocatorSpec.by 只能是 role|label|testId|text|css；优先 role+name。',
    '3. navigate/click/fill/press/select 必须带非空 expect 后置条件；screenshot/wait/scroll 可省略。',
    '4. branch 只允许一层（then 内不得再有 branch/forEach）；forEach.maxItems 不得超过 30。',
    `5. 总步骤数不得超过 ${STEP_LIMIT}；优先 extract+assert 组合而不是猜测。`,
    '6. 不要发明 values 中不存在的键；敏感值用 valuesRef 引用。',
    '7. 目标不可达或信息不足时，输出 {"steps":[]}。',
    '8. 不要生成 upload 步骤（本地文件路径是调用方资源，规划器不得发明）。',
  ].join('\n');
}

function userPrompt(input: PlannerInput): string {
  return JSON.stringify({
    goal: input.goal,
    successCriteria: input.successCriteria,
    valuesKeys: input.valuesKeys,
    allowedOrigins: input.allowedOrigins,
    currentUrl: input.currentUrl,
  });
}

const ACTION_NAMES = new Set(['navigate', 'click', 'fill', 'press', 'select', 'scroll', 'wait', 'screenshot', 'upload']);
/** 导航与写操作必须提供后置条件；纯观察动作可由返回证据验证（DESIGN §8.1）。 */
export const WRITE_ACTIONS = new Set(['navigate', 'click', 'fill', 'press', 'select', 'upload']);
const LOCATOR_BY = new Set(['role', 'label', 'testId', 'text', 'css']);
const EXPECT_KINDS = new Set(['url_contains', 'text_present', 'visible', 'hidden', 'count_gte', 'download_completed', 'var_equals']);

function validateLocator(raw: unknown, where: string): void {
  if (typeof raw !== 'object' || raw === null) throw err('PLANNER_INVALID_OUTPUT', `${where} 必须是对象`);
  const spec = raw as Record<string, unknown>;
  if (!LOCATOR_BY.has(String(spec.by))) throw err('PLANNER_INVALID_OUTPUT', `${where}.by 非法: ${String(spec.by)}`);
}

function validateExpects(raw: unknown, where: string): ActionStep['expect'] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw err('PLANNER_INVALID_OUTPUT', `${where} 必须是数组`);
  return raw.map((e, i) => {
    if (typeof e !== 'object' || e === null) throw err('PLANNER_INVALID_OUTPUT', `${where}[${i}] 必须是对象`);
    const spec = e as Record<string, unknown>;
    if (!EXPECT_KINDS.has(String(spec.kind))) {
      throw err('PLANNER_INVALID_OUTPUT', `${where}[${i}].kind 非法: ${String(spec.kind)}`);
    }
    return spec as unknown as ActionStep['expect'][number];
  });
}

/** 严格校验规划输出：模型只能产出白名单步骤（DESIGN §7）。 */
export function validatePlannedSteps(raw: unknown, depth = 0): FlowStep[] {
  if (!Array.isArray(raw)) throw err('PLANNER_INVALID_OUTPUT', 'steps 必须是数组');
  if (raw.length > STEP_LIMIT) throw err('PLANNER_INVALID_OUTPUT', `步骤数 ${raw.length} 超过上限 ${STEP_LIMIT}`);
  return raw.map((s, idx): FlowStep => {
    if (typeof s !== 'object' || s === null) throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}] 不是对象`);
    const step = s as Record<string, unknown>;
    const id = typeof step.id === 'string' && step.id ? step.id : `p${idx}`;
    switch (step.kind) {
      case 'action': {
        const action = String(step.action);
        if (!ACTION_NAMES.has(action)) throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}].action 非法: ${action}`);
        if (step.target !== undefined) validateLocator(step.target, `steps[${idx}].target`);
        const expect = validateExpects(step.expect, `steps[${idx}].expect`);
        if (WRITE_ACTIONS.has(action) && expect.length === 0) {
          throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}] 写操作 ${action} 缺少 expect 后置条件`);
        }
        if (action === 'navigate' && step.value === undefined && step.valuesRef === undefined) {
          throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}] navigate 需要 value 或 valuesRef`);
        }
        if (action === 'upload') {
          if (typeof step.filePath !== 'string' || !path.isAbsolute(step.filePath)) {
            throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}] upload 需要绝对路径 filePath`);
          }
        }
        const out: ActionStep = {
          id,
          kind: 'action',
          action: action as ActionStep['action'],
          expect,
        };
        if (step.target !== undefined) out.target = step.target as ActionStep['target'];
        if (typeof step.value === 'string' || typeof step.value === 'number') out.value = step.value;
        if (typeof step.valuesRef === 'string') out.valuesRef = step.valuesRef;
        if (typeof step.key === 'string') out.key = step.key;
        return out;
      }
      case 'assert':
        return { id, kind: 'assert', expect: validateExpects(step.expect, `steps[${idx}].expect`) };
      case 'extract': {
        validateLocator(step.target, `steps[${idx}].target`);
        const fields = Array.isArray(step.fields) ? (step.fields.filter((f) => f === 'text' || f === 'count') as Array<'text' | 'count'>) : [];
        if (fields.length === 0) throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}].fields 非法`);
        if (typeof step.saveAs !== 'string' || !step.saveAs) throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}].saveAs 非法`);
        return { id, kind: 'extract', target: step.target as never, fields, saveAs: step.saveAs };
      }
      case 'branch': {
        if (depth > 0) throw err('PLANNER_INVALID_OUTPUT', 'branch 不允许嵌套');
        if (typeof step.variable !== 'string') throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}].variable 非法`);
        const then = validatePlannedSteps(step.then, depth + 1);
        return { id, kind: 'branch', variable: step.variable, equals: step.equals as string | number, then };
      }
      case 'forEach': {
        if (depth > 0) throw err('PLANNER_INVALID_OUTPUT', 'forEach 不允许嵌套');
        const maxItems = Number(step.maxItems);
        if (!Number.isFinite(maxItems) || maxItems < 1 || maxItems > 30) {
          throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}].maxItems 必须在 1..30`);
        }
        if (typeof step.itemsVar !== 'string' || typeof step.itemVar !== 'string') {
          throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}] itemsVar/itemVar 非法`);
        }
        const body = validatePlannedSteps(step.body, depth + 1);
        return { id, kind: 'forEach', itemsVar: step.itemsVar, itemVar: step.itemVar, maxItems, body };
      }
      case 'goal': {
        if (typeof step.goal !== 'string' || !step.goal) throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}].goal 非法`);
        const out: FlowStep = { id, kind: 'goal', goal: step.goal, expect: validateExpects(step.expect, `steps[${idx}].expect`) };
        if (typeof step.valuesRef === 'string') (out as { valuesRef?: string }).valuesRef = step.valuesRef;
        return out;
      }
      default:
        throw err('PLANNER_INVALID_OUTPUT', `steps[${idx}].kind 非法: ${String(step.kind)}`);
    }
  });
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** openai-compatible Provider：/chat/completions + JSON 输出 + 一次受控修复请求（DESIGN §7）。 */
export class OpenAICompatibleProvider implements PlannerProvider {
  private readonly stats: ChatUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };

  constructor(
    private readonly opts: {
      cfg: PlannerConfig;
      /** key 由调用方从 apiKeyEnv 读取后注入；保留在内存，不写日志。 */
      apiKey?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  usage(): ChatUsage & { model?: string } {
    return { ...this.stats, model: this.lastModel };
  }

  private lastModel: string | undefined;

  private async chat(messages: ChatMessage[], jsonMode: boolean): Promise<string> {
    const { cfg, apiKey, fetchImpl = fetch } = this.opts;
    if (!apiKey) throw err('PLANNER_NOT_CONFIGURED', `缺少规划模型 key（${cfg.apiKeyEnv}）`);
    const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0 };
    if (jsonMode) body.response_format = { type: 'json_object' };
    this.stats.requests += 1;
    const res = await fetchImpl(`${cfg.baseUrl!.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 某些兼容端点不支持 response_format：退化为纯提示重试一次
      if (res.status === 400 && jsonMode) return this.chat(messages, false);
      throw err('PLANNER_INVALID_OUTPUT', `规划服务 ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { input_tokens?: number; prompt_tokens?: number; output_tokens?: number; completion_tokens?: number } };
    this.stats.inputTokens += data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0;
    this.stats.outputTokens += data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0;
    if (data.model) this.lastModel = data.model;
    return data.choices?.[0]?.message?.content ?? '';
  }

  async replan(input: PlannerInput & { completedStepIds: string[]; pausedReason: string }): Promise<FlowStep[]> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() + '\n这是重规划：只输出尚未完成的后缀步骤，不要重复已完成步骤。' },
      {
        role: 'user',
        content: JSON.stringify({
          goal: input.goal,
          successCriteria: input.successCriteria,
          valuesKeys: input.valuesKeys,
          allowedOrigins: input.allowedOrigins,
          currentUrl: input.currentUrl,
          completedStepIds: input.completedStepIds,
          pausedReason: input.pausedReason,
        }),
      },
    ];
    const content = await this.chat(messages, true);
    const parsed = JSON.parse(extractJson(content)) as { steps?: unknown };
    return validatePlannedSteps(parsed.steps);
  }

  async plan(input: PlannerInput): Promise<FlowStep[]> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(input) },
    ];
    let content = await this.chat(messages, true);
    let steps: FlowStep[];
    try {
      const parsed = JSON.parse(extractJson(content)) as { steps?: unknown };
      steps = validatePlannedSteps(parsed.steps);
    } catch (first) {
      messages.push({ role: 'assistant', content: content.slice(0, 4000) });
      messages.push({
        role: 'user',
        content: `你的输出未通过校验：${(first as Error).message}。请重新输出符合规则的 JSON {"steps":[...]}。`,
      });
      content = await this.chat(messages, true);
      try {
        const parsed = JSON.parse(extractJson(content)) as { steps?: unknown };
        steps = validatePlannedSteps(parsed.steps);
      } catch (second) {
        throw err('PLANNER_INVALID_OUTPUT', `规划输出两次校验失败: ${(second as Error).message}`);
      }
    }
    return steps;
  }
}

function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw err('PLANNER_INVALID_OUTPUT', '输出中找不到 JSON 对象');
  return candidate.slice(start, end + 1);
}
