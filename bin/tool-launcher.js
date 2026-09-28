#!/usr/bin/env node
/**
 * 工具集合启动器（Tool Launcher）
 *
 * 仓库根目录的入口只做一件事：
 *   1. 解析命令行参数中的工具名（如 server-a）
 *   2. 定位 tools/<工具名>/ 目录
 *   3. 如有必要：安装依赖（pnpm/npm）并构建（tsc -b）
 *   4. 以子进程方式启动该工具的入口，并透传 stdio / 信号 / 退出码
 *
 * 本项目是「工具集合」：每个工具是一份 core + 适配器（cli / mcp / …）的代码，
 * 核心逻辑与提供方式分离 —— 同一个工具可以以多种方式提供。
 *
 * 入口解析优先级：
 *   - launcher.json 声明（command + args，任意语言实现）
 *   - TypeScript 工作区布局：mcp/dist/index.js（tsc 构建产物；旧版单文件 index.js 仍兼容）
 *
 * 用法：
 *   tool-collection <tool-name> [extra args...]   以 MCP 方式启动某个工具
 *   tool-collection list                          列出所有可用工具
 *   tool-collection build <tool-name>             安装依赖并构建某个工具
 *   tool-collection help                          显示帮助
 *
 * 注意：stdout 是 MCP stdio 协议通道，启动器自身与安装/构建的一切日志都输出到 stderr！
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TOOLS_ROOT = path.join(__dirname, '..', 'tools');
const IS_WIN = process.platform === 'win32';

const exists = (p) => fs.existsSync(p);

/** 选择包管理器：优先 pnpm（原生 workspace 支持），否则回退 npm */
function pickRunner() {
  const res = spawnSync('pnpm', ['-v'], { stdio: 'ignore', shell: IS_WIN });
  return res.status === 0 ? 'pnpm' : 'npm';
}

/** 工具是否为 workspace（含 pnpm-workspace.yaml 或 workspace 根 package.json） */
function isWorkspace(toolDir) {
  return exists(path.join(toolDir, 'pnpm-workspace.yaml')) || exists(path.join(toolDir, 'package.json'));
}

/**
 * 读取多语言工具的声明文件 launcher.json：
 *   {
 *     "description": "…",          // 可选，list 时展示
 *     "command": "python",          // 启动命令（任意可执行程序）
 *     "args": ["mcp_server.py"],    // 启动参数
 *     "setup": [["uv", "sync"]]      // 可选，build 子命令时执行的环境准备命令
 *   }
 */
function readLauncherManifest(toolDir) {
  const p = path.join(toolDir, 'launcher.json');
  if (!exists(p)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (m && typeof m.command === 'string') return m;
    console.error(`[launcher] ${p} 缺少 "command" 字段，忽略该声明。`);
    return null;
  } catch (err) {
    console.error(`[launcher] 解析 ${p} 失败：${err.message}`);
    return null;
  }
}

function readPkgField(toolDir, field) {
  const pkgPath = path.join(toolDir, 'package.json');
  if (!exists(pkgPath)) return '';
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'))[field] || '';
  } catch (_) {
    return '';
  }
}

function readDescription(toolDir) {
  const fromPkg = readPkgField(toolDir, 'description');
  if (fromPkg) return fromPkg;
  const manifest = readLauncherManifest(toolDir);
  return (manifest && manifest.description) || '';
}

/** 扫描 tools/ 下所有可用工具（workspace / 旧版单文件 / launcher.json 声明均可） */
function listTools() {
  if (!exists(TOOLS_ROOT)) return [];
  return fs
    .readdirSync(TOOLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => {
      const dir = path.join(TOOLS_ROOT, d.name);
      return isWorkspace(dir) || exists(path.join(dir, 'index.js')) || exists(path.join(dir, 'launcher.json'));
    })
    .map((d) => d.name)
    .sort();
}

function printTools() {
  const tools = listTools();
  if (tools.length === 0) {
    console.error('tools/ 目录下暂无可用工具。');
    return;
  }
  console.error(`可用的工具（位于 ${TOOLS_ROOT}）：`);
  for (const name of tools) {
    const desc = readDescription(path.join(TOOLS_ROOT, name));
    console.error(`  - ${name}${desc ? '  ' + desc : ''}`);
  }
}

function printHelp() {
  console.error(`工具集合启动器

每个工具是一份 core + 适配器（cli / mcp / …）的代码：core 存放核心逻辑（纯函数/类），
各适配器以不同方式（MCP / CLI / 未来更多）对外提供同一个工具，共享同一份实现。

用法：
  npx github:<用户名>/<仓库名> <tool-name> [extra args...]

命令：
  list                    列出 tools/ 目录下所有可用的工具
  build <tool-name>       安装依赖并构建某个工具（开发调试用）
  help, -h, --help        显示本帮助

说明：
  <tool-name> 对应 tools/<tool-name>/ 子目录。
  TypeScript 工作区工具：首次启动自动安装依赖（优先 pnpm，回退 npm）并执行 tsc 构建，
  拉起 mcp/dist/index.js（兼容旧版单文件 index.js）。
  任意语言的工具：在子目录放一个 launcher.json（声明 command/args）即可被拉起，
  可选 setup 字段描述环境准备命令（由 build 子命令触发）。
  也可以用 CLI 适配器直接调用同一批工具：
    node tools/<tool-name>/cli/dist/index.js --help`);
}

/**
 * 定位工具的 MCP 入口：
 *   - 多语言声明布局：launcher.json（command + args，任意语言实现）
 *   - 新版 workspace 布局：mcp/dist/index.js（TypeScript 构建产物）
 *   - 旧版单文件布局：index.js
 */
function resolveEntry(toolDir) {
  const manifest = readLauncherManifest(toolDir);
  if (manifest) return { manifest };
  const workspaceEntry = path.join(toolDir, 'mcp', 'dist', 'index.js');
  if (exists(workspaceEntry)) return { entry: workspaceEntry, workspace: true };
  const legacyEntry = path.join(toolDir, 'index.js');
  if (exists(legacyEntry)) return { entry: legacyEntry, workspace: false };
  return null;
}

/**
 * 确保 workspace 工具就绪：按需安装依赖、按需构建。
 * 所有安装/构建输出重定向到本进程的 stderr，避免污染 stdout（MCP 协议通道）。
 */
function ensureReady(toolDir, toolName, { forceBuild = false } = {}) {
  // 声明式工具：环境准备命令由 launcher.json 的 setup 提供，仅在显式 build 时执行
  const manifest = readLauncherManifest(toolDir);
  if (manifest) {
    if (forceBuild && Array.isArray(manifest.setup) && manifest.setup.length > 0) {
      for (const cmd of manifest.setup) {
        console.error(`[launcher] [${toolName}] 运行 setup：${cmd.join(' ')}`);
        const res = spawnSync(cmd[0], cmd.slice(1), {
          cwd: toolDir,
          stdio: ['ignore', process.stderr.fd, process.stderr.fd],
          shell: IS_WIN,
        });
        if (res.status !== 0) {
          console.error(`[launcher] "${toolName}" setup 失败，退出。`);
          return false;
        }
      }
    }
    return true;
  }

  if (!isWorkspace(toolDir)) return true; // 旧版单文件工具，无需处理

  const distEntry = path.join(toolDir, 'mcp', 'dist', 'index.js');
  const needInstall = !exists(path.join(toolDir, 'node_modules'));
  const needBuild = forceBuild || !exists(distEntry);
  if (!needInstall && !needBuild) return true;

  const runner = pickRunner();
  const runInDir = (args) => {
    const res = spawnSync(runner, args, {
      cwd: toolDir,
      stdio: ['ignore', process.stderr.fd, process.stderr.fd],
      shell: IS_WIN,
    });
    return res.status;
  };

  if (needInstall) {
    console.error(`[launcher] 使用 ${runner} 安装 "${toolName}" 的依赖...`);
    const code = runInDir(runner === 'pnpm' ? ['install'] : ['install', '--no-audit', '--no-fund']);
    if (code !== 0) {
      console.error(`[launcher] "${toolName}" 依赖安装失败，退出。`);
      return false;
    }
  }

  if (needBuild) {
    console.error(`[launcher] 正在构建 "${toolName}"（tsc -b）...`);
    const code = runInDir(['run', 'build']);
    if (code !== 0) {
      console.error(`[launcher] "${toolName}" 构建失败，退出。`);
      return false;
    }
  }
  return true;
}

const [, , toolName, ...restArgs] = process.argv;

// ---------- 无参数 / 帮助 ----------
if (!toolName || ['-h', '--help', 'help'].includes(toolName)) {
  printHelp();
  printTools();
  process.exit(0);
}

// ---------- 列出工具 ----------
if (['-l', '--list', 'list'].includes(toolName)) {
  printTools();
  process.exit(0);
}

// ---------- 校验工具名（防止路径穿越） ----------
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(toolName)) {
  console.error(`[launcher] 非法的工具名："${toolName}"（只允许字母、数字、"."、"_"、"-"）。`);
  process.exit(1);
}

const toolDir = path.join(TOOLS_ROOT, toolName);

// ---------- 构建（开发调试用） ----------
if (toolName === 'build') {
  const target = restArgs[0];
  if (!target || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)) {
    console.error('[launcher] 用法：build <tool-name>');
    process.exit(1);
  }
  const dir = path.join(TOOLS_ROOT, target);
  if (!exists(dir)) {
    console.error(`[launcher] 未找到工具 "${target}"。`);
    printTools();
    process.exit(1);
  }
  const ok = ensureReady(dir, target, { forceBuild: true });
  if (ok) console.error(`[launcher] "${target}" 已就绪。`);
  process.exit(ok ? 0 : 1);
}

if (!exists(toolDir)) {
  console.error(`[launcher] 未找到工具 "${toolName}"（期望存在 ${toolDir}）。`);
  printTools();
  process.exit(1);
}

// ---------- 按需安装依赖并构建 ----------
if (!ensureReady(toolDir, toolName)) {
  process.exit(1);
}

// ---------- 定位入口 ----------
const resolved = resolveEntry(toolDir);
if (!resolved) {
  console.error(`[launcher] 工具 "${toolName}" 缺少可执行入口：`);
  console.error(`  - ${path.join(toolDir, 'launcher.json')}（多语言声明布局）`);
  console.error(`  - ${path.join(toolDir, 'mcp', 'dist', 'index.js')}（workspace 布局，需先构建）`);
  console.error(`  - ${path.join(toolDir, 'index.js')}（旧版单文件布局）`);
  console.error(`可尝试运行：npx github:AI-Redfish/Tool build ${toolName}`);
  process.exit(1);
}

// ---------- 启动子进程（声明式：任意语言；默认：Node） ----------
console.error(`[launcher] 以 MCP 方式启动工具 "${toolName}" ...`);
const isManifest = !!resolved.manifest;
const command = isManifest ? resolved.manifest.command : process.execPath;
const spawnArgs = isManifest
  ? [...(resolved.manifest.args || []), ...restArgs]
  : [resolved.entry, ...restArgs];
const child = spawn(command, spawnArgs, {
  cwd: isManifest ? toolDir : path.dirname(resolved.entry),
  stdio: 'inherit', // stdin/stdout/stderr 全部透传，stdout 即 MCP stdio 协议通道
  env: { ...process.env, TOOL_NAME: toolName },
});

child.on('error', (err) => {
  console.error(`[launcher] 启动子进程失败：${err.message}`);
  process.exit(1);
});

// 转发终止信号，保证客户端断开时子进程一起退出
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch (_) {
      /* 子进程可能已退出 */
    }
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal);
    } catch (_) {
      process.exit(1);
    }
  } else {
    process.exit(code === null ? 1 : code);
  }
});
