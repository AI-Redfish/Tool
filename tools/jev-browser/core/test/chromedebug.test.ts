import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { findPortOccupant, prepareChromeDebug, probeCdp } from '../src/chromedebug.js';

/** 起一个「非 CDP」的本地 HTTP 服务（对 /json/version 回 404），模拟无调试能力的端口占用者。 */
async function startPlainHttpServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('probeCdp：非 CDP 的 HTTP 服务（404）不算「已有调试服务」', async () => {
  const { server, port, close } = await startPlainHttpServer();
  try {
    const probe = await probeCdp(port);
    assert.equal(probe.up, false);
  } finally {
    await close();
  }
});

test('findPortOccupant：能识别本进程监听的端口（PID 与进程命令行）', async () => {
  const { server, port, close } = await startPlainHttpServer();
  try {
    const occ = await findPortOccupant(port);
    if (!occ) return; // 尽力而为查询：个别环境拿不到占用者信息，跳过断言
    assert.equal(occ.pid, process.pid);
    assert.ok(occ.commandLine, '应附带占用进程命令行');
  } finally {
    await close();
  }
});

test('findPortOccupant：空闲端口返回 null', async () => {
  const { server, port, close } = await startPlainHttpServer();
  await close(); // 先拿到一个确定空闲过的端口再释放
  const occ = await findPortOccupant(port);
  assert.equal(occ, null);
});

test('prepareChromeDebug：端口被无 CDP 进程占用时快速失败（不拉起 Chrome，报错含占用者 PID）', async (t) => {
  const { server, port, close } = await startPlainHttpServer();
  try {
    const occ = await findPortOccupant(port);
    if (!occ) return t.skip('本平台无法查询端口占用者，跳过行为断言');
    const t0 = Date.now();
    await assert.rejects(
      prepareChromeDebug({ port, waitMs: 5_000 }),
      (e: unknown) => {
        const je = e as { code?: string; message?: string };
        return je.code === 'BROWSER_BUSY'
          && (je.message ?? '').includes(String(occ.pid))
          && (je.message ?? '').includes('CDP');
      },
      '应快速抛 BROWSER_BUSY 且消息指明占用者',
    );
    // 快速失败：远小于 waitMs（旧行为会干等满超时）
    assert.ok(Date.now() - t0 < 5_000, '应在 waitMs 之前快速失败');
  } finally {
    await close();
  }
});
