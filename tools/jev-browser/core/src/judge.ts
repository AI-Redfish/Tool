import { TypeSafeClient, type EntryType, type Questions, type TypeSafeClientConfig } from '@typesafe-ai/sdk';
import type { JevConfig } from './config.js';
import { err } from './errors.js';
import { redactUrl } from './ports.js';
import type { PageObservation } from './observe.js';

/**
 * Jev 判断适配（DESIGN §6.3）：同一份 state 上一次请求并行问多个独立问题。
 * Jev 只做闭集选择/是否判断，不生成自由文本；候选覆盖是调用方的责任。
 * 阈值是 dev 初值，必须按业务数据校准（DESIGN §6.3 / RESEARCH S10）。
 */

export const GOAL_ACTIONS = ['click', 'fill', 'press', 'select', 'scroll', 'wait', 'none'] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];

export interface RoundDecision {
  done: number;
  doneConfirm: number;
  blocked: number;
  error: number;
  action: GoalAction;
  targetIndex: number | null;
  valueKey: string | null;
  /** 交付给审计的证据：分项概率。 */
  probabilities: Record<string, unknown>;
  /** 本轮实际发给模型的候选（targetIndex 对应此数组的下标，非全量 observation）。 */
  candidates: PageObservation['elements'];
  /** 服务实际返回的模型标识（DESIGN §11：记录模型实际版本）。 */
  model?: string;
}

export interface RoundObservationInput {
  goal: string;
  observation: PageObservation;
  valuesKeys: string[];
  recentActions: string[];
  diff: { urlChanged: boolean; elementsAdded: number; elementsRemoved: number };
  candidateLimit?: number;
}

export interface JudgePort {
  available(): boolean;
  decideRound(input: RoundObservationInput): Promise<RoundDecision>;
  /** 独立是/否校验（browser_check 场景）。 */
  check(state: Record<string, unknown>, question: string): Promise<number>;
  /** usage.model = 服务实际返回的模型标识（DESIGN §11）。 */
  usage(): { jevRequests: number; inputTokens: number; outputTokens: number; model?: string };
}

const MAX_CANDIDATES = 200;

/** 候选超限时按目标关键词相关性筛选作用域（DESIGN §6.2：先筛选再选择，不截断装满）。 */
export function scopeCandidates(obs: PageObservation, goal: string, limit: number): PageObservation['elements'] {
  const tokens = goal.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const scored = obs.elements.map((e) => {
    const hay = `${e.role} ${e.name} ${e.text}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

function buildQuestions(input: RoundObservationInput): { questions: Questions; candidates: PageObservation['elements'] } {
  const limit = input.candidateLimit ?? MAX_CANDIDATES;
  const candidates = input.observation.elements.length > limit
    ? scopeCandidates(input.observation, input.goal, limit)
    : input.observation.elements;

  const criteria: Record<string, string> = { none: '页面上没有能推进目标的元素' };
  candidates.forEach((e, idx) => {
    criteria[`c${idx}`] = `${e.role} "${e.name}"（序号 ${idx}）`;
  });

  const valueCriteria: Record<string, string> = { none: '本动作不需要输入值' };
  for (const k of input.valuesKeys) valueCriteria[k] = `使用 values 中的 "${k}"`;

  const questions: Questions = {
    done: {
      type: 'noul',
      instructions: {
        goal: input.goal,
        question: '当前页面状态是否表明目标已经完成？（填写表单本身不等于提交完成）',
      },
      criteria: { true: '目标已达成，无需进一步操作', false: '目标尚未达成' },
    },
    doneConfirm: {
      type: 'noul',
      instructions: {
        goal: input.goal,
        question: '严格确认：目标已完成，且不需要任何进一步操作（包括点击提交/搜索类按钮）？',
      },
    },
    blocked: {
      type: 'noul',
      instructions: { question: '页面是否被验证码、登录墙、拒绝访问等阻塞？' },
      criteria: { true: '被人机验证/权限/登录墙阻塞', false: '未阻塞' },
    },
    error: {
      type: 'noul',
      instructions: { question: '页面是否显示了错误信息（如输入错误、加载失败）？' },
    },
    tool: {
      type: 'choice',
      instructions: { goal: input.goal, question: '为了推进目标，下一步应该执行哪个动作？' },
      criteria: Object.fromEntries(GOAL_ACTIONS.map((a) => [a, ACTION_DESC[a]])),
    },
    target: {
      type: 'choice',
      instructions: { goal: input.goal, question: '执行该动作应作用于哪个元素？元素列表见 state.elements（序号 i）。' },
      criteria,
    },
    value: {
      type: 'choice',
      instructions: { goal: input.goal, question: '该动作的输入值应使用哪个 values 键？' },
      criteria: valueCriteria,
    },
  };
  return { questions, candidates };
}

const ACTION_DESC: Record<GoalAction, string> = {
  click: '点击目标元素（链接/按钮/勾选）',
  fill: '向目标文本框输入选定的 values 值（替换现有内容）',
  press: '在目标上按 Enter/其他键',
  select: '在下拉框中选择输入值',
  scroll: '向下滚动以加载或显示更多内容',
  wait: '等待页面加载/处理（spinner、busy 按钮）',
  none: '无需动作：目标已达成或本页无法推进',
};

export class TypeSafeJudge implements JudgePort {
  private client: TypeSafeClient | null;
  private readonly cfg: JevConfig;
  private readonly stats = { jevRequests: 0, inputTokens: 0, outputTokens: 0 };
  private lastModel: string | undefined;

  constructor(cfg: JevConfig, opts?: { client?: TypeSafeClient; env?: NodeJS.ProcessEnv }) {
    this.cfg = cfg;
    const env = opts?.env ?? process.env;
    if (opts?.client) {
      this.client = opts.client;
    } else {
      const key = env[cfg.apiKeyEnv];
      // 每次尝试 30s 超时（SDK 默认 10s 对页面状态判断偏短）；SDK 自带重试，本工具不叠加外层重试（DESIGN §6.4）
      this.client = key ? new TypeSafeClient({ apiKey: key, timeout: 30_000 } satisfies TypeSafeClientConfig) : null;
    }
  }

  available(): boolean {
    return this.client !== null;
  }

  usage(): { jevRequests: number; inputTokens: number; outputTokens: number; model?: string } {
    return { ...this.stats, model: this.lastModel };
  }

  private requireClient(): TypeSafeClient {
    if (!this.client) throw err('JEV_NOT_CONFIGURED', `缺少 Jev API key（环境变量 ${this.cfg.apiKeyEnv}）；纯确定性 execute 不需要它`);
    return this.client;
  }

  async decideRound(input: RoundObservationInput): Promise<RoundDecision> {
    const client = this.requireClient();
    const { questions, candidates } = buildQuestions(input);
    const state = {
      goal: input.goal,
      // URL query/fragment 裁剪：防止查询串中的 token/凭据进入云模型（DESIGN §10）
      url: redactUrl(input.observation.url),
      title: input.observation.title,
      elements: candidates,
      valuesKeys: input.valuesKeys,
      recentActions: input.recentActions.slice(-5),
      diff: input.diff,
      truncated: input.observation.truncated,
    };
    this.stats.jevRequests += 1;
    // ObservedElement 是纯 JSON 值；序列化以满足 SDK 的 EntryType（JsonValue）约束
    const result = await client.systemOne({ state: JSON.parse(JSON.stringify(state)) as EntryType, model: this.cfg.model, questions });
    this.lastModel = result.model;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.outputTokens += result.usage?.output_tokens ?? 0;

    const a = result.answers as Record<string, any>;
    const targetChoice = String(a.target?.choice ?? 'none');
    const targetIndex = targetChoice === 'none' ? null : Number(targetChoice.slice(1));
    const valueKey = String(a.value?.choice ?? 'none');
    const action = String(a.tool?.choice ?? 'none') as GoalAction;
    return {
      done: Number(a.done?.noul ?? 0),
      doneConfirm: Number(a.doneConfirm?.noul ?? 0),
      blocked: Number(a.blocked?.noul ?? 0),
      error: Number(a.error?.noul ?? 0),
      action,
      targetIndex: Number.isFinite(targetIndex) && targetIndex !== null ? targetIndex : null,
      valueKey: valueKey === 'none' ? null : valueKey,
      probabilities: {
        target: a.target?.probabilities ?? {},
        tool: a.tool?.probabilities ?? {},
      },
      candidates,
      model: result.model,
    };
  }

  async check(state: Record<string, unknown>, question: string): Promise<number> {
    const client = this.requireClient();
    const questions: Questions = { check: { type: 'noul', instructions: question } };
    this.stats.jevRequests += 1;
    const result = await client.systemOne({ state: JSON.parse(JSON.stringify(state)) as EntryType, model: this.cfg.model, questions });
    this.lastModel = result.model;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.outputTokens += result.usage?.output_tokens ?? 0;
    return Number((result.answers as Record<string, any>).check?.noul ?? 0);
  }
}
