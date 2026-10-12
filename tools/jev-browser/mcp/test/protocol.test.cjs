const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const envForTask = (status = 'done') => ({
  schemaVersion: 1, taskId: 't1', sessionId: 's1', mode: 'execute', revision: 1,
  status, stepResults: [{ id: 's1', kind: 'action', status: status === 'done' ? 'done' : 'paused' }],
  metrics: { queuedMs: 0, runningMs: 0, actions: 1, jevRequests: 0, plannerRequests: 0 }, artifacts: [],
});

async function withMcp(fastMode, run) {
  const calls = [];
  let taskStatus = 'done';
  let authError = false;
  let openNewPage = false;
  let submitted = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/tasks/execute' || req.url === '/v1/sessions/s1/act') {
      if (authError) {
        res.writeHead(403); res.end(JSON.stringify({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'denied' } })); return;
      }
      submitted = true;
      res.writeHead(202); res.end(JSON.stringify(envForTask(taskStatus))); return;
    }
    if (req.url === '/v1/tasks/t1') { res.end(JSON.stringify({ envelope: envForTask('done') })); return; }
    if (req.url === '/v1/sessions/s1/pages') {
      res.end(JSON.stringify({ pages: submitted && openNewPage ? [{ pageId: 'p0' }, { pageId: 'p1' }] : [{ pageId: 'p0' }] })); return;
    }
    if (req.url === '/v1/sessions/s1/page') { res.end(JSON.stringify({ pageId: body.pageId })); return; }
    if (req.url === '/v1/sessions/s1/snapshot') { res.end(JSON.stringify({ title: 'result', elements: [{ name: body.filter ?? 'search' }] })); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'jev-mcp-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '../dist/index.js')],
    env: { ...process.env, JEV_BROWSER_API_URL: baseUrl, JEV_BROWSER_API_TOKEN: 'test-token',
      JEV_BROWSER_MCP_FAST_MODE: fastMode ? 'true' : 'false',
      NODE_USE_ENV_PROXY: '0', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1' },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    await run({ client, calls,
      reset: () => { calls.length = 0; submitted = false; },
      setStatus: (value) => { taskStatus = value; },
      setAuthError: (value) => { authError = value; },
      setOpenPage: (value) => { openNewPage = value; },
    });
  } finally {
    await client.close();
    await transport.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
const decode = (result) => JSON.parse(result.content[0].text);

test('MCP stdio: compatible defaults, per-call fast path and observation schema validation', { timeout: 20000 }, async () => {
  await withMcp(false, async ({ client, calls, reset }) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 15);
    for (const name of ['browser_execute', 'browser_act']) {
      const schema = tools.find((tool) => tool.name === name).inputSchema;
      assert.ok(schema.properties.detectNewTabs);
      assert.ok(schema.properties.observationOptions);
    }
    const result = decode(await client.callTool({ name: 'browser_execute', arguments: {
      sessionId: 's1', steps: ['scroll:20'], observationOptions: { filter: '搜索', roles: ['button'], maxElements: 10 },
    } }));
    assert.equal(result.status, 'done'); assert.ok(result.afterObservation); assert.ok(result.mcpMetrics);
    assert.deepEqual(calls.map((c) => c.url), ['/v1/sessions/s1/pages', '/v1/tasks/execute', '/v1/sessions/s1/pages', '/v1/sessions/s1/snapshot']);
    assert.deepEqual(calls.at(-1).body, { forModel: false, viewportOnly: true, maxElements: 10, filter: '搜索', roles: ['button'] });
    assert.deepEqual(calls[1].body, { sessionId: 's1', steps: ['scroll:20'], values: {} });
    reset();
    const fast = decode(await client.callTool({ name: 'browser_execute', arguments: {
      sessionId: 's1', steps: ['click:css/#submit => text_present:完成', 'scroll:10'],
      detectNewTabs: false, includeObservation: false,
    } }));
    assert.equal(fast.afterObservation, undefined);
    assert.deepEqual(calls.map((c) => c.url), ['/v1/tasks/execute']);
    reset();
    const invalid = await client.callTool({ name: 'browser_act', arguments: {
      sessionId: 's1', step: 'scroll:10', observationOptions: { maxElements: 2001 },
    } });
    assert.equal(invalid.isError, true); assert.equal(calls.length, 0);
  });
});

test('MCP stdio: server fast mode, explicit new-tab follow and filtered observation', { timeout: 20000 }, async () => {
  await withMcp(true, async ({ client, calls, reset, setOpenPage, setStatus, setAuthError }) => {
    const result = decode(await client.callTool({ name: 'browser_act', arguments: { sessionId: 's1', step: 'scroll:10' } }));
    assert.equal(result.status, 'done'); assert.equal(result.afterObservation, undefined);
    assert.deepEqual(calls.map((c) => c.url), ['/v1/sessions/s1/act']);
    reset(); setOpenPage(true);
    const observed = decode(await client.callTool({ name: 'browser_execute', arguments: {
      sessionId: 's1', steps: ['click:css/a => text_present:详情'], followNewTab: true, includeObservation: true,
      observationOptions: { filter: '详情', maxElements: 5 },
    } }));
    assert.equal(observed.followedPageId, 'p1'); assert.ok(observed.afterObservation);
    assert.deepEqual(calls.map((c) => c.url), ['/v1/sessions/s1/pages', '/v1/tasks/execute', '/v1/sessions/s1/pages', '/v1/sessions/s1/page', '/v1/sessions/s1/snapshot']);
    reset(); setStatus('queued');
    const queued = decode(await client.callTool({ name: 'browser_execute', arguments: { sessionId: 's1', steps: ['scroll:10'] } }));
    assert.equal(queued.status, 'done');
    assert.deepEqual(calls.map((c) => c.url), ['/v1/tasks/execute', '/v1/tasks/t1']);
    reset(); setStatus('paused');
    const paused = decode(await client.callTool({ name: 'browser_act', arguments: { sessionId: 's1', step: 'scroll:10' } }));
    assert.equal(paused.status, 'paused'); assert.equal(calls.length, 1);
    reset(); setAuthError(true);
    const denied = await client.callTool({ name: 'browser_execute', arguments: { sessionId: 's1', steps: ['scroll:10'] } });
    assert.equal(denied.isError, true); assert.equal(decode(denied).error.code, 'ORIGIN_NOT_ALLOWED'); assert.equal(calls.length, 1);
  });
});
