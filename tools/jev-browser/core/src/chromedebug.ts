import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultUserConfigFile, loadConfig } from './config.js';
import { err } from './errors.js';

const execFileP = promisify(execFile);

/**
 * Chrome 固定调试端口启动器（attach 前置步骤）。
 *
 * 背景：Chrome 136+ 出于安全禁止在默认用户数据目录上启用
 * --remote-debugging-port；Chrome 144+ 的 chrome://inspect 授权通道端口随机。
 * 因此 attach 调试用固定端口 + 独立 profile 目录启动一个专用 Chrome 实例：
 *
 *   chrome --remote-debugging-port=9223 --user-data-dir=<专用目录>
 *
 * 跨平台（win32/darwin/linux）：可执行文件路径、profile 目录、
 * 环境变量写法均按平台适配。已在本端口监听时跳过启动（幂等）。
 */

export const DEFAULT_CHROME_DEBUG_PORT = 9223;

/**
 * 自动确保固定端口调试 Chrome（默认开启）：attach 连接前探测，未启动则自动拉起。
 * 设 JEV_BROWSER_AUTO_LAUNCH_DEBUG=false/0 可恢复旧行为（不自动启动，仅报错指引用户）。
 */
export function autoLaunchDebugChromeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.JEV_BROWSER_AUTO_LAUNCH_DEBUG;
  return !(v === 'false' || v === '0');
}

/** 同端口并发去重：MCP/API 多会话同时连接时只启动一次，其余等待后复用。 */
const inflight = new Map<number, Promise<ChromeDebugResult>>();

/** 各平台 Chrome 可执行文件候选（按优先级）。 */
export function chromeExecutableCandidates(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
      const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
      const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
      return [
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];
    }
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(home, 'Applications', 'Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ];
    default:
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
      ];
  }
}

/** 找到本机 Chrome 可执行文件；找不到抛 CAPABILITY_UNSUPPORTED。 */
export function findChromeExecutable(explicit?: string): string {
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...(process.env.JEV_BROWSER_CHROME_EXECUTABLE ? [process.env.JEV_BROWSER_CHROME_EXECUTABLE] : []),
    ...chromeExecutableCandidates(),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      // 下一个候选
    }
  }
  throw err('CAPABILITY_UNSUPPORTED',
    `未找到 Chrome 可执行文件。已尝试：${candidates.join(' ; ')}。` +
    `请用 --executable <路径> 或环境变量 JEV_BROWSER_CHROME_EXECUTABLE 显式指定。`,
    { details: { tried: candidates } });
}

/** 调试专用 profile 目录（绝不用日常默认目录：Chrome 136+ 会拒绝在默认目录开调试端口）。 */
export function defaultChromeDebugUserDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      // 固定 C 盘用户目录（不随盘符/习惯位置变化）：C:\Users\<用户>\AppData\Local\AI-Redfish\...
      const base = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
      return path.join(base, 'AI-Redfish', 'jev-browser', 'chrome-debug-profile');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'AI-Redfish', 'jev-browser', 'chrome-debug-profile');
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'AI-Redfish', 'jev-browser', 'chrome-debug-profile');
  }
}

export interface CdpProbe {
  up: boolean;
  /** /json/version 的 Browser 字段（如 "Chrome/145.0.7369.62"），非 Chrome 服务可能取不到。 */
  browser?: string;
}

export interface PortOccupant {
  pid: number;
  /** 进程名（尽力而为，从命令行提取）。 */
  name?: string;
  /** 命令行（尽力而为，已截断）。 */
  commandLine?: string;
}

function truncateLine(s: string, n = 200): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Windows 下查进程命令行（尽力而为；失败返回空对象）。 */
async function winProcessInfo(pid: number): Promise<Pick<PortOccupant, 'name' | 'commandLine'>> {
  try {
    const { stdout } = await execFileP('powershell.exe',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { timeout: 5000 });
    const commandLine = stdout.trim();
    if (!commandLine) return {};
    const exe = /^"([^"]+)"/.exec(commandLine)?.[1] ?? commandLine.split(/\s+/)[0] ?? '';
    return { name: exe.split(/[\\/]/).pop(), commandLine: truncateLine(commandLine) };
  } catch {
    return {};
  }
}

/**
 * 查询 TCP 端口的监听进程（尽力而为，查不到/查询失败返回 null）。
 *
 * 用途：区分「端口空闲」与「端口被无 CDP 能力的进程占用」（如日常 Chrome、其他程序）。
 * 后者再拉起调试 Chrome，新实例无法绑定调试端口（进程照常启动但无 DevTools 服务），
 * 只会白等超时——应快速失败并指明占用者（见 prepareChromeDebug）。
 */
export async function findPortOccupant(port: number): Promise<PortOccupant | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('netstat', ['-ano', '-p', 'tcp'], { timeout: 3000 });
      let pid: number | undefined;
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/); // 协议 本地地址 远程地址 状态 PID
        if ((cols[1] ?? '').endsWith(`:${port}`)) {
          const last = Number(cols[cols.length - 1]);
          if (Number.isFinite(last) && last > 0) pid = last;
          break;
        }
      }
      if (!pid) return null;
      return { pid, ...(await winProcessInfo(pid)) };
    }
    // darwin / linux：lsof（未安装则视为查不到，退回原有行为）
    const { stdout } = await execFileP('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 3000 });
    const row = stdout.split(/\r?\n/).slice(1).find((l) => l.trim() !== '');
    if (!row) return null;
    const pid = Number(row.trim().split(/\s+/)[1]);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try {
      const { stdout: cl } = await execFileP('ps', ['-p', String(pid), '-o', 'command='], { timeout: 2000 });
      const commandLine = truncateLine(cl);
      return { pid, name: commandLine.split(/\s+/)[0]?.split('/').pop(), commandLine };
    } catch {
      return { pid };
    }
  } catch {
    return null; // 尽力而为：任何失败都退回「查不到占用者」
  }
}

/** 探测本机回环 CDP 端点是否已有调试服务在监听。 */
export async function probeCdp(port: number, timeoutMs = 1500): Promise<CdpProbe> {
  const url = `http://127.0.0.1:${port}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { up: false };
    try {
      const v = (await res.json()) as { Browser?: string };
      return { up: true, browser: v.Browser };
    } catch {
      return { up: true };
    }
  } catch {
    return { up: false };
  }
}

/** 轮询等待 CDP 就绪（启动后端口监听有延迟）。 */
async function waitForCdp(port: number, waitMs: number): Promise<CdpProbe> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const p = await probeCdp(port, 1000);
    if (p.up) return p;
    if (Date.now() >= deadline) return p;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export interface ChromeDebugOptions {
  /** 固定调试端口，默认 9223。 */
  port?: number;
  /** 调试专用 profile 目录，默认按平台选取。 */
  userDataDir?: string;
  /** Chrome 可执行文件；缺省按平台候选查找。 */
  executable?: string;
  /** 启动后等待 CDP 就绪的时长（毫秒），默认 15000。 */
  waitMs?: number;
}

export interface ChromeDebugResult {
  port: number;
  endpoint: string;
  /** 启动前端口已在监听（跳过启动）。 */
  alreadyRunning: boolean;
  launched: boolean;
  chromePath: string;
  userDataDir: string;
  browserVersion?: string;
}

/**
 * 确保「固定调试端口」的 Chrome 已在运行：
 *  - 端口已监听 → 直接返回（不重复启动）；
 *  - 未监听 → 以 --remote-debugging-port=<port> --user-data-dir=<dir> 分离启动
 *    （进程独立于本命令，命令退出浏览器不退出），并等待 CDP 就绪。
 */
export async function prepareChromeDebug(opts: ChromeDebugOptions = {}): Promise<ChromeDebugResult> {
  const port = opts.port ?? DEFAULT_CHROME_DEBUG_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw err('CONFIG_INVALID', `调试端口非法: ${port}`);
  }
  const running = inflight.get(port);
  if (running) return running;
  const task = prepareChromeDebugOnce(opts, port).finally(() => inflight.delete(port));
  inflight.set(port, task);
  return task;
}

async function prepareChromeDebugOnce(opts: ChromeDebugOptions, port: number): Promise<ChromeDebugResult> {
  const userDataDir = opts.userDataDir ?? defaultChromeDebugUserDataDir();
  if (!path.isAbsolute(userDataDir)) {
    throw err('CONFIG_INVALID', `user-data-dir 需要绝对路径: ${userDataDir}`);
  }
  const endpoint = `http://127.0.0.1:${port}`;

  const before = await probeCdp(port);
  if (before.up) {
    return { port, endpoint, alreadyRunning: true, launched: false, chromePath: '', userDataDir, browserVersion: before.browser };
  }

  const chromePath = findChromeExecutable(opts.executable);

  // 端口已被监听但未提供 CDP 调试服务（如日常 Chrome、其他程序占用了端口）：
  // 此时再 spawn Chrome，新实例无法绑定调试端口（进程照常启动但无 DevTools），
  // 只会白等超时——快速失败并指出占用者，给出可操作的出路。
  const occupant = await findPortOccupant(port);
  if (occupant) {
    // 消息前 200 字符需包含关键信息与全部出路（failures 拼接会截断），命令行详情放末尾
    throw err('BROWSER_BUSY',
      `端口 ${port} 已被 PID ${occupant.pid}${occupant.name ? `（${occupant.name}）` : ''} 占用且未提供 CDP 调试服务（/json/version 不可用），在此端口启动调试 Chrome 无法绑定调试端口。` +
      `出路：① 换端口 chrome-debug --port <其他端口>；② 走授权流程接管日常 Chrome（chrome://inspect/#remote-debugging，Chrome ≥ 144）；③ 结束占用进程后重试。` +
      `占用者命令行：${occupant.commandLine ?? '未知'}`,
      { retryable: true, details: { endpoint, port, occupant } });
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  try {
    // detached + ignore stdio：Chrome 独立成进程，CLI 退出不影响
    const child = spawn(chromePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    throw err('BROWSER_BUSY', `启动 Chrome 失败（${chromePath}）: ${(e as Error).message}`);
  }

  const after = await waitForCdp(port, opts.waitMs ?? 15_000);
  if (!after.up) {
    // 竞态兜底：启动间隙被其他进程抢占端口时，指出具体占用者；否则按 profile 冲突提示
    const late = await findPortOccupant(port);
    const why = late
      ? `端口 ${port} 现被占用（PID ${late.pid}${late.commandLine ? `：${late.commandLine}` : ''}）——新实例大概率未能绑定调试端口。`
      : `常见原因：profile 目录被另一个 Chrome 实例占用（${userDataDir}），或新启动的 Chrome 未能绑定端口 ${port}。`;
    throw err('BROWSER_BUSY',
      `Chrome 已启动，但 ${endpoint} 在 ${opts.waitMs ?? 15_000}ms 内未就绪。${why}`,
      { details: { endpoint, userDataDir, port, occupant: late ?? undefined } });
  }
  return { port, endpoint, alreadyRunning: false, launched: true, chromePath, userDataDir, browserVersion: after.browser };
}

/**
 * attach 路径用：确保显式 loopback 端点上有调试 Chrome（有则复用，无则自动启动）。
 * 启动失败不直接报错——记入 failures 后继续正常连接尝试，最终 BROWSER_BUSY 附带原因。
 */
export async function ensureDebugChromeAt(
  endpointUrl: string,
  opts: { waitMs?: number; failures: string[]; env?: NodeJS.ProcessEnv },
): Promise<void> {
  if (!autoLaunchDebugChromeEnabled(opts.env ?? process.env)) return;
  let port: number | undefined;
  try {
    const u = new URL(endpointUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'ws:') return; // https/wss 非本工具拉起的调试端口形态
    port = u.port ? Number(u.port) : undefined;
  } catch {
    return;
  }
  if (!port) return;
  const probe = await probeCdp(port);
  if (probe.up) return; // 已在运行 → 复用，不重复启动
  try {
    await prepareChromeDebug({ port, waitMs: opts.waitMs });
  } catch (e) {
    opts.failures.push(`auto-launch(127.0.0.1:${port}): ${(e as Error).message.split('\n')[0].slice(0, 200)}`);
  }
}

/**
 * 把 attach 端点持久化进用户配置文件（browser.attach.endpoint），
 * 后续 CLI/MCP/API 无需再设环境变量。写入前整体校验，失败则回滚原文件。
 */
export function saveAttachEndpointToUserConfig(endpoint: string, file?: string): { file: string; created: boolean } {
  const target = file ?? defaultUserConfigFile();
  const existed = fs.existsSync(target);
  let original: Buffer | null = null;
  let parsed: Record<string, unknown> = {};
  if (existed) {
    original = fs.readFileSync(target);
    try {
      parsed = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
    } catch (e) {
      throw err('CONFIG_INVALID', `配置文件不是合法 JSON，拒绝改写: ${target}: ${(e as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw err('CONFIG_INVALID', `配置文件顶层必须是对象: ${target}`);
    }
  }
  const browser = (parsed.browser ?? {}) as Record<string, unknown>;
  const attach = (browser.attach ?? {}) as Record<string, unknown>;
  if (Array.isArray(browser) || typeof browser !== 'object') throw err('CONFIG_INVALID', `配置文件 browser 必须是对象: ${target}`);
  if (Array.isArray(attach) || typeof attach !== 'object') throw err('CONFIG_INVALID', `配置文件 browser.attach 必须是对象: ${target}`);
  attach.endpoint = endpoint;
  browser.attach = attach;
  parsed.browser = browser;
  if (parsed.schemaVersion === undefined) parsed.schemaVersion = 1;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  // 写入后整体校验；失败回滚，绝不留下打不开的配置
  try {
    loadConfig({ file: target, env: {} });
  } catch (e) {
    if (existed && original) fs.writeFileSync(target, original);
    else fs.rmSync(target, { force: true });
    throw err('CONFIG_INVALID', `写入 attach 端点后配置校验失败，已回滚（${target}）: ${(e as Error).message}`);
  }
  return { file: target, created: !existed };
}
