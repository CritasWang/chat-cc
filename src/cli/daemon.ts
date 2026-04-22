import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { fork, execSync, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidPath, logPath, chatccHome } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, '..', 'main.js');

export async function runDaemon(action: 'start' | 'stop' | 'restart' | 'status', args: string[]): Promise<void> {
  switch (action) {
    case 'start':
      await start(args);
      break;
    case 'stop':
      await stop();
      break;
    case 'restart':
      await stop();
      await start(args);
      break;
    case 'status':
      status();
      break;
  }
}

async function start(args: string[]): Promise<void> {
  const foreground = args.includes('--foreground') || args.includes('-f');

  const pid = readPid();
  if (pid && isAlive(pid)) {
    console.log(`chat-cc 已在运行 (pid: ${pid})`);
    return;
  }
  cleanPid();

  if (foreground) {
    console.log('chat-cc 前台模式启动...');
    const { main } = await import('../main.js');
    await main({ foreground: true });
    return;
  }

  const child: ChildProcess = fork(SERVER_ENTRY, ['--daemon'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, CHAT_CC_DAEMON: '1' },
  });

  const childPid = child.pid;
  if (!childPid) {
    console.error('启动失败：无法获取子进程 PID');
    process.exit(1);
  }

  child.disconnect();
  child.unref();
  writePid(childPid);
  console.log(`✅ chat-cc 已启动 (pid: ${childPid})`);
  console.log(`   日志: ${logPath()}`);
  console.log(`   配置: ${chatccHome()}/config.yaml`);
}

async function stop(): Promise<void> {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    console.log('chat-cc 未在运行');
    cleanPid();
    return;
  }

  process.kill(pid, 'SIGTERM');

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!isAlive(pid)) {
      cleanPid();
      console.log('🛑 chat-cc 已停止');
      return;
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }
  cleanPid();
  console.log('🛑 chat-cc 已强制停止 (SIGKILL)');
}

function status(): void {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    console.log('chat-cc 未在运行');
    return;
  }

  const uptime = processUptime(pid);
  console.log(`chat-cc 运行中`);
  console.log(`  PID:    ${pid}`);
  if (uptime) console.log(`  运行:   ${uptime}`);
  console.log(`  日志:   ${logPath()}`);
  console.log(`  配置:   ${chatccHome()}/config.yaml`);
}

function readPid(): number | undefined {
  const p = pidPath();
  if (!existsSync(p)) return undefined;
  const raw = readFileSync(p, 'utf8').trim();
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function writePid(pid: number): void {
  mkdirSync(dirname(pidPath()), { recursive: true });
  writeFileSync(pidPath(), String(pid), 'utf8');
}

function cleanPid(): void {
  try { unlinkSync(pidPath()); } catch { /* ok */ }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processUptime(pid: number): string | undefined {
  try {
    const out = execSync(`ps -o etime= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
