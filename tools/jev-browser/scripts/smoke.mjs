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
const PRINCIPAL = 'smoke';
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
    const s = await rt.createSession(PRINCIPAL, {
      target: { kind: 'new', url: `${base}/` },
      allowedOrigins: [base],
      modelOrigins: [],
    });
    if (s.status === 'awaiting_page') throw new Error(`意外的 awaiting_page: ${JSON.stringify(s.candidates)}`);
    sessionId = s.sessionId;
    check('connect+createSession(launch/chromium/headless)', true, `session=${sessionId}`);

    // 2) 确定性流程：导航 → 提取 → 断言 → 下载 → 截图（模型调用必须为 0）
    const flow = {
      steps: [
        { id: 'nav', kind: 'action', action: 'navigate', value: `${base}/`,
          expect: [{ kind: 'url_contains', value: '127.0.0.1' }] },
        { id: 'read', kind: 'extract', target: { by: 'role', role: 'heading', name: 'JEV Smoke Fixture', exact: true },
          fields: ['text', 'count'], saveAs: 'heading' },
        { id: 'verify', kind: 'assert', expect: [{ kind: 'var_equals', variable: 'heading.text', value: 'JEV Smoke Fixture' }] },
        { id: 'dl', kind: 'action', action: 'click', target: { by: 'css', selector: '#dl' },
          expect: [{ kind: 'download_completed', variable: 'report' }] },
        { id: 'shot', kind: 'action', action: 'screenshot' },
      ],
      values: {},
    };
    const queued = await rt.execute(PRINCIPAL, sessionId, flow, { idempotencyKey: 'smoke-1' });
    taskId = queued.taskId;
    const env = await rt.waitEnvelope(taskId);
    check('execute → done', env.status === 'done',
      env.status !== 'done' ? JSON.stringify(env.error ?? env.stepResults?.filter((x) => x.status !== 'done')) : '');
    const metrics = env.metrics ?? {};
    check('模型调用为 0（纯确定性）',
      (metrics.plannerRequests ?? 0) === 0 && (metrics.judgeRequests ?? 0) === 0,
      JSON.stringify(metrics));

    // 3) 产物：下载文件与截图受管落盘，取回并比对内容
    const arts = rt.listArtifacts(PRINCIPAL, taskId);
    const report = arts.find((a) => a.filename.includes('.txt'));
    const shots = arts.filter((a) => /\.(png|jpe?g|webm)$/.test(a.filename));
    check('下载产物已受管保存', Boolean(report), JSON.stringify(arts.map((a) => a.filename)));
    check('截图产物已保存', shots.length >= 1);
    if (report) {
      const { path: src } = rt.artifactPath(PRINCIPAL, taskId, report.artifactId);
      const out = path.join(tmpRoot, 'saved-report.txt');
      fs.copyFileSync(src, out);
      const content = fs.readFileSync(out, 'utf8');
      check('下载内容完整（saveAs 保真）', content === 'SMOKE-REPORT-CONTENT-123', content.slice(0, 60));
    }

    // 4) 幂等：同键同体重放不产生第二个任务
    const replay = await rt.execute(PRINCIPAL, sessionId, flow, { idempotencyKey: 'smoke-1' });
    check('幂等重放返回原任务', replay.taskId === taskId);

    // 5) 断开与清理
    const d = await rt.disconnect(PRINCIPAL, sessionId, {});
    check('disconnect 完成', d.ok !== false, JSON.stringify(d));
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
