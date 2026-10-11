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
  /** 目标选择的置信度：优先取服务端给的 confidence（校准值），退回该选项的原始概率。 */
  targetConfidence?: number;
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

/**
 * 发给 Jev 的候选上限。实测每候选≈76 token（state + criteria 各写一遍），
 * 整页 166 个元素 ≈ 14k token/轮；压到 80 后 ≈ 6k，而 Jev 每轮延迟也随之下降。
 * 取不到目标的后果是 Jev 选 none → 暂停交人（不会瞎点），是可接受的失败模式。
 */
const MAX_CANDIDATES = 80;

/** 候选超限时按目标关键词相关性筛选作用域（DESIGN §6.2：先筛选再选择，不截断装满）。 */
/** 去掉「同名标题」这类纯重复候选（保留对象原样，text 还要用于构造定位器）。 */
function dedupeCandidates(elements: PageObservation['elements']): PageObservation['elements'] {
  const named = new Set<string>();
  const out: PageObservation['elements'] = [];
  for (const e of elements) {
    if (e.role === 'heading' && named.has(e.name)) continue;
    if (e.role !== 'heading') named.add(e.name);
    out.push(e);
  }
  return out;
}

export function scopeCandidates(obs: PageObservation, goal: string, limit: number): PageObservation['elements'] {
  const g = goal.toLowerCase();
  const tokens = g.split(/\s+/).filter((t) => t.length > 1);
  const scored = dedupeCandidates(obs.elements).map((e, idx) => {
    const name = String(e.name ?? '').toLowerCase();
    const hay = `${e.role} ${name} ${e.text ?? ''}`.toLowerCase();
    let score = 0;
    // 方向一：目标里的词出现在元素上 —— 英文/空格分词有效
    for (const t of tokens) if (hay.includes(t)) score += 2;
    // 方向二：元素名出现在目标里 —— 中文没有空格，「点提交」整句是一个 token，
    // 方向一永远命中不了，候选筛选对中文等于失效。反向包含才是中文场景的正解。
    // 权重高于「在视口内」：真的被点名的元素，哪怕要滚动也该排前面。
    if (name.length > 1 && g.includes(name)) score += 4;
    // 视口内只是加成一档，用作同分时的优先（人的直觉：先看眼前能点的）
    if (e.inViewport) score += 1;
    return { e, idx, score };
  });
  // 同分保持文档顺序（稳定），避免每次观察的候选顺序抖动
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, limit).map((s) => s.e);
}

function buildQuestions(input: RoundObservationInput): { questions: Questions; candidates: PageObservation['elements'] } {
  const limit = input.candidateLimit ?? MAX_CANDIDATES;
  // 超过上限才筛；上限已压到 80（见 MAX_CANDIDATES），所以大页面一定会走筛选
  const candidates = input.observation.elements.length > limit
    ? scopeCandidates(input.observation, input.goal, limit)
    : input.observation.elements;

  // 候选标签默认**只给序号**：元素名已经写在 state.elements 里，标签再重复一遍纯属浪费。
  // 实测（真实长度中文标题、走 decideRound 忠实链路）：省 26% 输入 token，准确率一致；
  // 之所以能这么做，是因为 payload 的 `i` 与 criteria 的 `c{idx}` 已严格对齐、问题文本也
  // 明确说「元素列表见 state.elements（序号 i）」。需要标签自解释（排错、换小模型）时，
  // 置 JEV_BROWSER_CRITERIA_VERBOSE=1 回到 `role "name"（序号 i）` 的写法。
  const verboseLabels = process.env.JEV_BROWSER_CRITERIA_VERBOSE === '1';
  const criteria: Record<string, string> = { none: '页面上没有能推进目标的元素' };
  candidates.forEach((e, idx) => {
    criteria[`c${idx}`] = verboseLabels ? `${e.role} "${e.name}"（序号 ${idx}）` : `c${idx}`;
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
      instructions: { goal: input.goal, question: '执行该动作应作用于哪个元素？元素列表见 state.elements（序号 i，按与目标的相关性和是否在视口内排序）。' },
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
      this.client = key
        ? new TypeSafeClient({
            apiKey: key,
            timeout: 30_000,
            // 端点可覆盖：地区受限（451）时指向可达的代理/自建端点
            ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
          } satisfies TypeSafeClientConfig)
        : null;
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

  /**
   * SDK 抛错统一收口：Jev 是外部服务，最常见的两种失败是「地区不可用（451）」与「凭据无效（401）」。
   * 直接透传会变成一句 INTERNAL，调用方看不出该改什么；这里带上可执行的修复指引。
   * 地区限制可用 SDK 原生支持的 TYPESAFE_BASE_URL 指到可达端点（代理/自建），无需改代码。
   */
  private wrap<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((e: unknown) => {
      const msg = (e as Error)?.message ?? String(e);
      const is451 = /\b451\b/.test(msg);
      throw err(
        'JEV_UNAVAILABLE',
        `Jev 判断服务调用失败：${msg.slice(0, 200)}。` +
          (is451
            ? '451 多为地区限制，但**头号真因是代理没生效**：Node 不读 Windows 系统代理，只认环境变量。' +
              '若本机开了系统代理，需在启动进程前设置 HTTPS_PROXY=http://127.0.0.1:<端口> 与 ' +
              'NODE_USE_ENV_PROXY=1（该开关只在进程启动时读取；经仓库启动器拉起时会自动注入）。' +
              '若确为地区限制，用 JEV_BROWSER_JEV_BASE_URL / TYPESAFE_BASE_URL 指向可达端点。'
            : '若为凭据问题（401/403），检查 TYPESAFE_API_KEY。'),
        { retryable: false },
      );
    });
  }

  async decideRound(input: RoundObservationInput): Promise<RoundDecision> {
    const client = this.requireClient();
    const { questions, candidates } = buildQuestions(input);
    // 发给模型的元素只留判断真正用到的字段：
    //  - `tag` 从不参与任何提问；
    //  - `text` 与 `name` 恒等（观察脚本里同源），是纯粹的重复体积；
    //  - `i` 改用**候选切片内的序号**——问题文本说「序号 i」、criteria 说「序号 idx」，
    //    而 scopeCandidates 会重排，两者原本可能不一致，模型照 i 回答就会错位。
    // 内部候选对象保持完整：decision.candidates 仍按原下标使用，locatorFromCandidate 还要看 text。
    const payloadElements = candidates.map((e, idx) => ({ i: idx, role: e.role, name: e.name }));
    const state = {
      goal: input.goal,
      // URL query/fragment 裁剪：防止查询串中的 token/凭据进入云模型（DESIGN §10）
      url: redactUrl(input.observation.url),
      title: input.observation.title,
      elements: payloadElements,
      valuesKeys: input.valuesKeys,
      recentActions: input.recentActions.slice(-5),
      diff: input.diff,
      truncated: input.observation.truncated,
    };
    this.stats.jevRequests += 1;
    // ObservedElement 是纯 JSON 值；序列化以满足 SDK 的 EntryType（JsonValue）约束
    const result = await this.wrap(() =>
      client.systemOne({ state: JSON.parse(JSON.stringify(state)) as EntryType, model: this.cfg.model, questions }),
    );
    this.lastModel = result.model;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.outputTokens += result.usage?.output_tokens ?? 0;

    const a = result.answers as Record<string, any>;
    const targetChoice = String(a.target?.choice ?? 'none');
    const targetIndex = targetChoice === 'none' ? null : Number(targetChoice.slice(1));
    // 服务端在同一份 answers 里既给 choice（选了哪个）也给 confidence（多确定）。
    // 两个值可能不同（confidence 是校准过的），置信度闸门优先用 confidence。
    const rawConf = Number(a.target?.confidence);
    const probConf = Number(a.target?.probabilities?.[targetChoice]);
    const targetConfidence = targetIndex === null
      ? undefined
      : Number.isFinite(rawConf) ? rawConf : Number.isFinite(probConf) ? probConf : undefined;
    const valueKey = String(a.value?.choice ?? 'none');
    const action = String(a.tool?.choice ?? 'none') as GoalAction;
    return {
      done: Number(a.done?.noul ?? 0),
      doneConfirm: Number(a.doneConfirm?.noul ?? 0),
      blocked: Number(a.blocked?.noul ?? 0),
      error: Number(a.error?.noul ?? 0),
      action,
      targetIndex: Number.isFinite(targetIndex) && targetIndex !== null ? targetIndex : null,
      targetConfidence,
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
    const result = await this.wrap(() =>
      client.systemOne({ state: JSON.parse(JSON.stringify(state)) as EntryType, model: this.cfg.model, questions }),
    );
    this.lastModel = result.model;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.outputTokens += result.usage?.output_tokens ?? 0;
    return Number((result.answers as Record<string, any>).check?.noul ?? 0);
  }
}
