#!/usr/bin/env node
/**
 * @ai-redfish/jev-browser-cli —— CLI 适配器
 *
 * 只做参数解析与输出：业务全部在 @ai-redfish/jev-browser-core。
 * 进度/日志写 stderr；--json 时 stdout 仅输出 envelope（DESIGN §8.3）。
 * 退出码：0 done；2 参数/配置错误；3 paused；4 failed/expired；130 cancelled。
 */
import {
  ApiClient,
  Runtime,
  loadConfig,
  runDoctor,
  signGrant,
  validateExecuteSteps,
  type ActionStep,
  type TaskEnvelope,
  type ValueInput,
} from '@ai-redfish/jev-browser-core';
import * as fs from 'node:fs';

interface CliArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const value = eq === -1 ? undefined : a.slice(eq + 1);
      if (value === undefined) {
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
          const existing = flags[key];
          if (Array.isArray(existing)) (existing as string[]).push(argv[++i]);
          else if (existing !== undefined) flags[key] = [existing as string, argv[++i]];
          else flags[key] = argv[++i];
        } else {
          flags[key] = true;
        }
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

const HELP = `jev-browser-cli —— 浏览器控制（Playwright + Jev；方案见 tools/jev-browser/DESIGN.md）

用法：jev-browser-cli <命令> [参数]

命令：
  doctor [--connect]                          诊断配置/环境；--connect 尝试接管（需 Chrome 授权）
  connect (--url <url> | --page <id>) --origin <origin> [...]
                                              创建会话（origin 默认不许可任何网站）
  pages --session <id>                        列出标签页
  select-page --session <id> --page <id>      选择标签页
  snapshot --session <id> [--for-model]       只读页面快照（for-model 需 origin ∈ modelOrigins）
  execute --file <flow.json> (--url <url> | --page <id>) --origin <origin> [...]
                                              执行确定性步骤（不调用规划模型）
  run --goal <文本> --success <验收条件> (--url | --page) --origin ... [--model-origin ...]
                                              内部规划并执行（需 planner 与 Jev 配置）
  act --session <id> --step '<ActionStep JSON>' [--values '<json>']
  task get|cancel|resume|approve <taskId>     cancel/resume 需 --request-id；resume 未证实结果需 --rerun-confirm；
                                              run 任务恢复时 --replan 允许规划器重规划未完成后缀（受 maxReplans）
  grant create --task <id> --action-revision <n>   签发审批 grant（需 JEV_BROWSER_APPROVAL_KEY）
  artifact list --task <id>                   列出任务产物
  artifact get --task <id> --artifact <id> --out <path>
  disconnect --session <id> [--detach-task]

全局：--config <path>  --json  --api <http://127.0.0.1:3737>  --principal <name>
环境：JEV_BROWSER_*（见 DESIGN §5.2）；JEV_BROWSER_API_TOKEN；JEV_BROWSER_APPROVAL_KEY；JEV_BROWSER_SECRET_<NAME>
`;

function fail(message: string, code = 2): never {
  console.error(`[jev-browser-cli] ${message}`);
  process.exit(code);
}

function str(flags: CliArgs['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function originsOf(flags: CliArgs['flags'], key: string): string[] {
  const v = flags[key];
  if (v === undefined) return [];
  if (typeof v === 'string') return [v];
  return v as string[];
}

function readJson(flagValue: string | undefined, what: string): unknown {
  if (!flagValue) return undefined;
  if (flagValue === '-' || fs.existsSync(flagValue)) {
    const raw = flagValue === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(flagValue, 'utf8');
    return JSON.parse(raw);
  }
  return JSON.parse(flagValue);
}

function exitFor(env: TaskEnvelope): number {
  switch (env.status) {
    case 'done':
      return 0;
    case 'paused':
      return 3;
    case 'cancelled':
      return 130;
    case 'failed':
    case 'expired':
      return 4;
    default:
      return 0;
  }
}

function finish(env: TaskEnvelope, json: boolean): never {
  if (json) {
    console.log(JSON.stringify(env, null, 2));
  } else {
    const lines: string[] = [
      `status=${env.status}${env.pauseReason ? ` (${env.pauseReason})` : ''} taskId=${env.taskId} revision=${env.revision}`,
    ];
    if (env.error) lines.push(`error: [${env.error.code}] ${env.error.message}`);
    if (env.goalVerification) lines.push(`goalVerification: ${env.goalVerification.by} ok=${env.goalVerification.ok}${env.goalVerification.detail ? ` (${env.goalVerification.detail})` : ''}`);
    if (env.pendingApproval) {
      lines.push(`待审批: actionRevision=${env.pendingApproval.actionRevision} action=${env.pendingApproval.action} 原因=${env.pendingApproval.reason}`);
      lines.push(`批准方式: grant create --task ${env.taskId} --action-revision ${env.pendingApproval.actionRevision} 然后 task approve ${env.taskId} --grant <token>`);
    }
    if (env.artifacts.length > 0) lines.push(`artifacts: ${env.artifacts.map((a) => `${a.artifactId}(${a.filename},${a.size}B)`).join(', ')}`);
    for (const s of env.stepResults) lines.push(`  step ${s.id} [${s.kind}] ${s.status}${s.error ? ` ${s.error.code}` : ''}`);
    console.error(lines.join('\n'));
  }
  process.exit(exitFor(env));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const json = args.flags['json'] === true;
  const apiBase = str(args.flags, 'api');
  const principal = str(args.flags, 'principal') ?? 'local';

  if (args.command === 'help' || args.flags['h'] === true || args.flags['help'] === true) {
    console.error(HELP);
    process.exit(0);
  }

  const configOpts = { file: str(args.flags, 'config') };
  const token = process.env.JEV_BROWSER_API_TOKEN ?? '';

  // API 转发模式（长驻共享，DESIGN §9.2）
  let api: ApiClient | null = null;
  if (apiBase) {
    api = new ApiClient({ baseUrl: apiBase, token });
  }

  // 同一进程内复用同一 Runtime 实例（多个实例的 waiter/队列互不可见）
  let runtimePromise: Promise<Runtime> | null = null;
  const runtimeOf = (): Promise<Runtime> => {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        if (api) fail('该命令在 --api 模式下走转发路径，不需要本地 Runtime', 2);
        const { config } = loadConfig(configOpts);
        const rt = new Runtime(config);
        rt.recoverOnStartup();
        return rt;
      })();
    }
    return runtimePromise;
  };

  /** 一次性会话：execute/run/snapshot 的快捷方式。 */
  const ensureOneShotSession = async (rt: Runtime): Promise<string> => {
    const url = str(args.flags, 'url');
    const pageId = str(args.flags, 'page');
    const allowed = originsOf(args.flags, 'origin');
    const modelOrigins = originsOf(args.flags, 'model-origin');
    if (!url && !pageId) fail('需要 --url 或 --page 指定目标标签页');
    const target = url ? { kind: 'new' as const, url } : { kind: 'existing' as const, pageId };
    const s = await rt.createSession(principal, { target, allowedOrigins: allowed, modelOrigins });
    if (s.status === 'awaiting_page') {
      console.error(`[jev-browser-cli] 存在多个候选标签页，请用 --page 指定：${JSON.stringify(s.candidates)}`);
      process.exit(3);
    }
    return s.sessionId;
  };

  switch (args.command) {
    case 'doctor': {
      if (api) {
        console.log(JSON.stringify(await api.diagnostics(), null, 2));
        return;
      }
      const result = await runDoctor({ ...configOpts, attemptConnect: args.flags['connect'] === true });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.error(`配置文件: ${result.config.file ?? '(未使用，默认值)'}`);
        if (result.config.envKeys.length) console.error(`环境变量覆盖: ${result.config.envKeys.join(', ')}`);
        for (const c of result.checks) console.error(`[${c.ok ? 'OK' : 'FAIL'}] ${c.name}: ${c.detail}`);
        if (result.capabilities?.length) {
          for (const cap of result.capabilities) console.error(`[capability] ${cap.id}: ${cap.state}${cap.detail ? ` — ${cap.detail}` : ''}`);
        }
        if (result.connect) console.error(`[connect] ${result.connect.ok ? 'OK' : 'FAIL'}: ${result.connect.detail}`);
      }
      const connectFail = result.connect && !result.connect.ok;
      process.exit(connectFail ? 4 : 0);
      return;
    }

    case 'connect': {
      const url = str(args.flags, 'url');
      const pageId = str(args.flags, 'page');
      if (!url && !pageId) fail('connect 需要 --url 或 --page');
      const input = {
        target: url ? { kind: 'new', url } : { kind: 'existing', pageId },
        allowedOrigins: originsOf(args.flags, 'origin'),
        modelOrigins: originsOf(args.flags, 'model-origin'),
      };
      const result = api ? await api.createSession(input) : await (await runtimeOf()).createSession(principal, input as never);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case 'pages': {
      const sessionId = str(args.flags, 'session');
      if (!sessionId) fail('pages 需要 --session');
      const result = api ? await api.pages(sessionId) : await (await runtimeOf()).listPages(principal, sessionId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case 'select-page': {
      const sessionId = str(args.flags, 'session');
      const pageId = str(args.flags, 'page');
      if (!sessionId || !pageId) fail('select-page 需要 --session 与 --page');
      const result = api ? await api.selectPage(sessionId, pageId) : await (await runtimeOf()).selectPage(principal, sessionId, pageId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case 'snapshot': {
      const sessionId = str(args.flags, 'session');
      if (api) {
        if (!sessionId) fail('--api 模式需要 --session');
        const obs = await api.snapshot(sessionId, args.flags['for-model'] === true);
        console.log(JSON.stringify(obs, null, 2));
        return;
      }
      const rt = await runtimeOf();
      const sid = sessionId ?? (await ensureOneShotSession(rt));
      const obs = await rt.snapshot(principal, sid, { forModel: args.flags['for-model'] === true });
      console.log(JSON.stringify(obs, null, 2));
      if (!sessionId) await rt.disconnect(principal, sid).catch(() => undefined);
      await rt.close();
      return;
    }

    case 'execute': {
      const raw = readJson(str(args.flags, 'file') ?? str(args.flags, 'steps'), 'steps');
      const values = readJson(str(args.flags, 'values'), 'values') as Record<string, ValueInput> | undefined;
      const input = { steps: raw, values: values ?? {} };
      validateExecuteSteps(input.steps as never);
      if (api) {
        const sessionId = str(args.flags, 'session');
        if (!sessionId) fail('--api 模式需要 --session（先 connect）');
        const res = await api.execute({ sessionId, ...input }, str(args.flags, 'idempotency-key'));
        const env = await pollApi(api, (res as unknown as TaskEnvelope).taskId);
        finish(env, json);
      }
      const rt = await runtimeOf();
      const sid = str(args.flags, 'session') ?? (await ensureOneShotSession(rt));
      const env = await rt.execute(principal, sid, input as never, { idempotencyKey: str(args.flags, 'idempotency-key') });
      const finalEnv = await rt.waitEnvelope(env.taskId);
      if (!str(args.flags, 'session')) await rt.disconnect(principal, sid).catch(() => undefined);
      await rt.close();
      finish(finalEnv, json);
      return;
    }

    case 'run': {
      const goal = str(args.flags, 'goal');
      const success = str(args.flags, 'success');
      if (!goal || !success) fail('run 需要 --goal 与 --success（验收条件，DESIGN §8.1）');
      const values = readJson(str(args.flags, 'values'), 'values') as Record<string, ValueInput> | undefined;
      const input = { goal, successCriteria: success, values: values ?? {} };
      if (api) {
        const sessionId = str(args.flags, 'session');
        if (!sessionId) fail('--api 模式需要 --session');
        const res = await api.run({ sessionId, ...input }, str(args.flags, 'idempotency-key'));
        const env = await pollApi(api, (res as unknown as TaskEnvelope).taskId);
        finish(env, json);
      }
      const rt = await runtimeOf();
      const sid = str(args.flags, 'session') ?? (await ensureOneShotSession(rt));
      const env = await rt.run(principal, sid, input as never, { idempotencyKey: str(args.flags, 'idempotency-key') });
      const finalEnv = await rt.waitEnvelope(env.taskId);
      if (!str(args.flags, 'session')) await rt.disconnect(principal, sid).catch(() => undefined);
      await rt.close();
      finish(finalEnv, json);
      return;
    }

    case 'act': {
      const sessionId = str(args.flags, 'session');
      if (!sessionId) fail('act 需要 --session');
      const step = readJson(str(args.flags, 'step'), 'step') as ActionStep;
      const values = (readJson(str(args.flags, 'values'), 'values') ?? {}) as Record<string, ValueInput>;
      if (api) {
        const res = await api.act(sessionId, { step, values });
        const env = await pollApi(api, (res as unknown as TaskEnvelope).taskId);
        finish(env, json);
      }
      const rt = await runtimeOf();
      const env = await rt.act(principal, sessionId, { sessionId, step, values });
      const finalEnv = await rt.waitEnvelope(env.taskId);
      await rt.close();
      finish(finalEnv, json);
      return;
    }

    case 'task': {
      const sub = args.positional[0];
      const taskId = args.positional[1] ?? str(args.flags, 'task');
      if (!sub || !taskId) fail('task 需要 get|cancel|resume|approve <taskId>');
      const rtPromise = api ? null : runtimeOf();
      if (sub === 'get') {
        const env = api ? (await api.getTask(taskId)).envelope : (await rtPromise!).getTask(principal, taskId);
        finish(env, json);
      }
      const requestId = str(args.flags, 'request-id') ?? newIdFromTime();
      const expectedRevision = str(args.flags, 'expected-revision');
      const opts = { requestId, expectedRevision: expectedRevision !== undefined ? Number(expectedRevision) : undefined };
      if (sub === 'cancel') {
        const env = api ? (await api.cancelTask(taskId, opts)).envelope : await (await rtPromise!).cancelTask(principal, taskId, opts);
        finish(env, json);
      }
      if (sub === 'resume') {
        const resumeOpts = {
          ...opts,
          rerunConfirmed: args.flags['rerun-confirm'] === true,
          allowReplan: args.flags['replan'] === true,
        };
        if (api) {
          const env = (await api.resumeTask(taskId, resumeOpts)).envelope;
          const finalEnv = ['queued', 'running', 'cancelling'].includes(env.status) ? await pollApi(api, taskId) : env;
          finish(finalEnv, json);
        }
        const rt = await rtPromise!;
        const env = await rt.resumeTask(principal, taskId, resumeOpts);
        const finalEnv = ['queued', 'running', 'cancelling'].includes(env.status) ? await rt.waitEnvelope(taskId) : env;
        await rt.close().catch(() => undefined);
        finish(finalEnv, json);
      }
      if (sub === 'approve') {
        const grant = str(args.flags, 'grant');
        if (!grant) fail('approve 需要 --grant <token>（由 grant create 签发）');
        const env = api ? (await api.approveTask(taskId, { grant })).envelope : (await rtPromise!).approveTask(principal, taskId, grant);
        finish(env, json);
      }
      fail(`未知 task 子命令: ${sub}`);
      return;
    }

    case 'grant': {
      if (args.positional[0] !== 'create') fail('用法：grant create --task <id> --action-revision <n>');
      const key = process.env.JEV_BROWSER_APPROVAL_KEY;
      if (!key) fail('缺少 JEV_BROWSER_APPROVAL_KEY（独立签发凭据；与执行 Agent 不同源才构成边界，见 DESIGN §10）');
      const taskId = str(args.flags, 'task');
      const actionRevision = Number(str(args.flags, 'action-revision'));
      if (!taskId || !Number.isFinite(actionRevision)) fail('grant create 需要 --task 与 --action-revision');
      const { config } = loadConfig(configOpts);
      const ttl = config.safety.approvalTtlMs;
      const token2 = signGrant(
        { grantId: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, taskId, actionRevision, action: '*', issuedAt: Date.now(), expiresAt: Date.now() + ttl },
        key,
      ).signature;
      if (json) console.log(JSON.stringify({ grant: token2, ttlMs: ttl }, null, 2));
      else console.log(token2);
      return;
    }

    case 'artifact': {
      const sub = args.positional[0];
      const taskId = str(args.flags, 'task');
      if (sub === 'list') {
        if (!taskId) fail('artifact list 需要 --task');
        const arts = api ? (await api.listArtifacts(taskId)).artifacts : (await runtimeOf()).listArtifacts(principal, taskId);
        console.log(JSON.stringify({ taskId, artifacts: arts }, null, 2));
        return;
      }
      if (sub === 'get') {
        const artifactId = str(args.flags, 'artifact');
        const out = str(args.flags, 'out');
        if (!taskId || !artifactId || !out) fail('artifact get 需要 --task/--artifact/--out');
        if (api) {
          await api.saveArtifact(taskId, artifactId, out);
        } else {
          const rt = await runtimeOf();
          const { path: src } = rt.artifactPath(principal, taskId, artifactId);
          fs.copyFileSync(src, out);
          await rt.close();
        }
        console.error(`已保存: ${out}`);
        return;
      }
      fail('用法：artifact list|get（见 help）');
      return;
    }

    case 'disconnect': {
      const sessionId = str(args.flags, 'session');
      if (!sessionId) fail('disconnect 需要 --session');
      const detach = args.flags['detach-task'] === true;
      const result = api ? await api.disconnect(sessionId, detach) : await (await runtimeOf()).disconnect(principal, sessionId, { detachTask: detach });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    default:
      fail(`未知命令: ${args.command}\n${HELP}`);
  }
}

async function pollApi(api: ApiClient, taskId: string): Promise<TaskEnvelope> {
  // 202 + 轮询（DESIGN §8.3）；本机服务轮询间隔 500ms，上限 30 分钟
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const { envelope } = await api.getTask(taskId);
    if (envelope.status === 'paused' || ['done', 'failed', 'expired', 'cancelled'].includes(envelope.status)) {
      return envelope;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('等待任务超时');
}

function newIdFromTime(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

main().catch((e: unknown) => {
  const errObj = e as { code?: string; message?: string };
  const codeMap: Record<string, number> = { CONFIG_INVALID: 2, INVALID_INPUT: 2 };
  console.error(`[jev-browser-cli] [${errObj.code ?? 'INTERNAL'}] ${errObj.message ?? e}`);
  process.exit(codeMap[errObj.code ?? ''] ?? 4);
});
