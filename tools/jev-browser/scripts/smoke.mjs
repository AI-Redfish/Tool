#!/usr/bin/env node
/**
 * jev-browser 冒烟测试（P0 最小 smoke，DEVELOPMENT_PLAN §3 交付物）。
 *
 * 边界：只操作本脚本自建的 fixture 与浏览器实例——
 *   - 本地 127.0.0.1 fixture HTTP 服务（随机端口）
 *   - launch 模式 + 受管 Chromium + 独立临时 profile + 独立临时 dataDir
 * 绝不 attach 日常 Chrome，绝不触碰用户 profile/标签页。
 *
 * 覆盖：连接（launch）→ 建会话 → 导航/提取/断言/截图 → 下载（artifact 受管落盘）
 *       → 产物取回与内容比对 → 断开清理 → 临时目录清理。
 *
 * 用法：node scripts/smoke.mjs [--keep]
 * 退出码：0 = go；1 = no-go（输出 JSON 摘要到 stdout，过程日志到 stderr）。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runtime, loadConfig } from '../core/dist/index.js';

const keep = process.argv.includes('--keep');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-smoke-'));
const log = (...a) => console.error('[smoke]', ...a);

/** 本地 fixture：页面 + 受控下载。 */
function serveFixture() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/report.txt') {
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="smoke-report.txt"',
        });
        res.end('SMOKE-REPORT-CONTENT-123');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>JEV Smoke Fixture</title></head>
<body><h1>JEV Smoke Fixture</h1><span id="status">ready</span>
<input id="kw" type="text" aria-label="关键词">
<a id="dl" href="/report.txt" download="smoke-report.txt">下载报告</a></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

async function main() {
  const server = await serveFixture();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  log(`fixture: ${base}`);

  // 独立配置：launch + 受管 Chromium + 无头 + 临时 profile/dataDir（不碰用户目录）
  const cfgFile = path.join(tmpRoot, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    schemaVersion: 1,
    browser: { mode: 'launch', engine: 'chromium', headless: true,
      launch: { userDataDir: path.join(tmpRoot, 'profile'), chromiumSandbox: true } },
    safety: { allowedOrigins: [base], modelOrigins: [] },
    runtime: { dataDir: path.join(tmpRoot, 'data') },
    planner: { enabled: false },
  }));
  const { config } = loadConfig({ file: cfgFile });

  const rt = new Runtime(config);
  rt.recoverOnStartup();
  let sessionId = null;
  let taskId = null;
  try {
    // 1) launch 连接 + 建会话（新页必须在授权域内）
    const s = await rt.createSession({
      target: { kind: 'new', url: `${base}/` },
      allowedOrigins: [base],
      modelOrigins: [],
    });
    if (s.status === 'awaiting_page') throw new Error(`意外的 awaiting_page: ${JSON.stringify(s.candidates)}`);
    sessionId = s.sessionId;
    check('connect+createSession(launch/chromium/headless)', true, `session=${sessionId}`);

    // 2) 确定性流程：导航 → 提取 → 断言 → 简写填空+值断言 → 下载 → 截图（模型调用必须为 0）
    //    'fill:... => value_equals:...' 是新增能力：一行式简写 + 输入值后置条件（真浏览器验证）
    const flow = {
      steps: [
        { id: 'nav', kind: 'action', action: 'navigate', value: `${base}/`,
          expect: [{ kind: 'url_contains', value: '127.0.0.1' }] },
        { id: 'read', kind: 'extract', target: { by: 'role', role: 'heading', name: 'JEV Smoke Fixture', exact: true },
          fields: ['text', 'count'], saveAs: 'heading' },
        { id: 'verify', kind: 'assert', expect: [{ kind: 'var_equals', variable: 'heading.text', value: 'JEV Smoke Fixture' }] },
        'fill:css/#kw=虎皮鹦鹉 => value_equals:css/#kw=虎皮鹦鹉',
        { id: 'dl', kind: 'action', action: 'click', target: { by: 'css', selector: '#dl' },
          expect: [{ kind: 'download_completed', variable: 'report' }] },
        { id: 'shot', kind: 'action', action: 'screenshot' },
      ],
      values: {},
    };
    const queued = await rt.execute(sessionId, { sessionId, steps: flow.steps, values: {} }, { idempotencyKey: 'smoke-1' });
    taskId = queued.taskId;
    const env = await rt.waitEnvelope(taskId);
    check('execute → done', env.status === 'done',
      env.status !== 'done' ? JSON.stringify(env.error ?? env.stepResults?.filter((x) => x.status !== 'done')) : '');
    check('简写步骤展开并执行（自动补 id）',
      env.stepResults.some((x) => x.id === 's4' && x.kind === 'action' && x.status === 'done'),
      JSON.stringify(env.stepResults.map((x) => `${x.id}:${x.status}`)));
    const metrics = env.metrics ?? {};
    check('模型调用为 0（纯确定性）',
      (metrics.plannerRequests ?? 0) === 0 && (metrics.jevRequests ?? 0) === 0,
      JSON.stringify(metrics));

    // 2b) 快照瘦身：视口过滤 + 元素上限；与 name 同源的 text 字段不再下发
    const obs = await rt.snapshot(sessionId, { viewportOnly: true, maxElements: 50 });
    check('snapshot 视口过滤 + 元素上限生效',
      Array.isArray(obs.elements) && obs.elements.length > 0 && obs.elements.length <= 50,
      `elements=${obs.elements?.length}`);
    check('snapshot 已剥离冗余 text 字段',
      obs.elements.every((e) => e.text === undefined),
      JSON.stringify(obs.elements[0] ?? null));

    // 2c) 快照按需收窄：filter（name 子串）与 roles
    const filtered = await rt.snapshot(sessionId, { viewportOnly: false, filter: 'JEV' });
    check('snapshot filter 生效（只留 name 命中的元素）',
      filtered.elements.length > 0 && filtered.elements.every((e) => e.name.toLowerCase().includes('jev')),
      `elements=${filtered.elements.length}: ${JSON.stringify(filtered.elements.map((e) => e.name))}`);
    const onlyTextbox = await rt.snapshot(sessionId, { viewportOnly: false, roles: ['textbox'] });
    check('snapshot roles 过滤生效',
      onlyTextbox.elements.length > 0 && onlyTextbox.elements.every((e) => e.role === 'textbox'),
      JSON.stringify(onlyTextbox.elements.map((e) => e.role)));

    // 3) 产物：下载文件与截图受管落盘，取回并比对内容
    const arts = rt.listArtifacts(taskId);
    const report = arts.find((a) => a.filename.includes('.txt'));
    const shots = arts.filter((a) => /\.(png|jpe?g|webm)$/.test(a.filename));
    check('下载产物已受管保存', Boolean(report), JSON.stringify(arts.map((a) => a.filename)));
    check('截图产物已保存', shots.length >= 1);
    if (report) {
      const { path: src } = rt.artifactPath(taskId, report.artifactId);
      const out = path.join(tmpRoot, 'saved-report.txt');
      fs.copyFileSync(src, out);
      const content = fs.readFileSync(out, 'utf8');
      check('下载内容完整（saveAs 保真）', content === 'SMOKE-REPORT-CONTENT-123', content.slice(0, 60));
    }

    // 4) 幂等：同键同体重放不产生第二个任务
    const replay = await rt.execute(sessionId, { sessionId, steps: flow.steps, values: {} }, { idempotencyKey: 'smoke-1' });
    check('幂等重放返回原任务', replay.taskId === taskId);

    // 5) 断开与清理
    const d = await rt.disconnect(sessionId, {});
    check('disconnect 完成', d.disconnected === true, JSON.stringify(d));
    sessionId = null;
  } finally {
    await rt.close({ graceMs: 3000 }).catch(() => undefined);
    server.close();
  }

  const ok = checks.every((c) => c.ok);
  const summary = {
    result: ok ? 'go' : 'no-go',
    checks,
    scope: 'launch 模式（受管 Chromium 无头 + 独立临时 profile）；attach 接管路径不在本脚本范围',
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!keep) fs.rmSync(tmpRoot, { recursive: true, force: true });
  else log(`保留临时目录: ${tmpRoot}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  checks.push({ name: '未捕获异常', ok: false, detail: String(e?.stack ?? e).slice(0, 400) });
  console.log(JSON.stringify({ result: 'no-go', checks }, null, 2));
  if (!keep) fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(1);
});
