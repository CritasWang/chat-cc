import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonLockPath, pidPath, logPath } from '../paths.js';
import { writeFileAtomicSync } from '../platform/atomic-write.js';
import { resolveConfigPath } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, '..', 'main.js');

interface PidRecord {
  pid: number;
  startedAt?: string;
  entry?: string;
}

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
  const lock = acquireStartLock();
  if (!lock.acquired) {
    console.log(`chat-cc 已在运行或正在启动${lock.ownerPid ? ` (pid: ${lock.ownerPid})` : ''}`);
    return;
  }

  let keepLock = false;
  let childPid: number | undefined;
  try {
    const existing = readPid();
    if (existing && isOwnedProcess(existing)) {
      rewriteLock(existing.pid);
      keepLock = true;
      console.log(`chat-cc 已在运行 (pid: ${existing.pid})`);
      return;
    }
    if (existing) cleanPid(existing.pid);

    if (foreground) {
      const record = processRecord(process.pid, process.argv[1]);
      writePid(record);
      rewriteLock(process.pid);
      keepLock = true;
      process.once('exit', () => {
        cleanPid(process.pid);
        cleanLock(process.pid);
      });
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

    childPid = child.pid;
    if (!childPid) throw new Error('无法获取子进程 PID');

    await waitUntilReady(child, 15_000);

    writePid(processRecord(childPid, SERVER_ENTRY));
    rewriteLock(childPid);
    keepLock = true;
    child.disconnect();
    child.unref();
    console.log(`✅ chat-cc 已启动 (pid: ${childPid})`);
    console.log(`   日志: ${logPath()}`);
    console.log(`   配置: ${resolveConfigPath()}`);
  } catch (err) {
    if (childPid !== undefined) {
      await terminateProcess(childPid, 2_000);
      cleanPid(childPid);
      cleanLock(childPid);
    }
    console.error(`启动失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    if (!keepLock) cleanLock(process.pid);
  }
}

async function stop(): Promise<void> {
  let record = readPid();
  if (!record || !isAlive(record.pid)) {
    if (record) cleanPid(record.pid);
    else if (existsSync(pidPath())) cleanPid();

    const lockOwner = readLockPid();
    if (lockOwner && isAlive(lockOwner)) {
      const command = processCommand(lockOwner);
      if (isStartingCommand(command)) {
        console.log(`chat-cc 正在启动 (pid: ${lockOwner})，未执行停止`);
        return;
      }
      const recovered = processRecord(lockOwner, SERVER_ENTRY);
      if (isOwnedProcess(recovered)) {
        // pid 文件可能被误删，但运行锁仍可证明这是本 daemon；恢复记录后正常停止。
        record = recovered;
        writePid(record);
      } else {
        console.error(`拒绝停止：启动锁由未知活进程 PID ${lockOwner} 持有`);
        process.exitCode = 1;
        return;
      }
    } else {
      if (lockOwner) cleanLock(lockOwner);
      else if (isOwnerlessLockStale()) cleanLock();
      console.log('chat-cc 未在运行');
      return;
    }
  }

  if (!isOwnedProcess(record)) {
    console.error(`拒绝停止：PID ${record.pid} 已被其他进程占用，已清理陈旧 pid 文件`);
    cleanPid(record.pid);
    cleanLock(record.pid);
    process.exitCode = 1;
    return;
  }

  process.kill(record.pid, 'SIGTERM');

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!isAlive(record.pid)) {
      cleanPid(record.pid);
      cleanLock(record.pid);
      console.log('🛑 chat-cc 已停止');
      return;
    }
  }

  try {
    process.kill(record.pid, 'SIGKILL');
  } catch { /* already dead */ }
  cleanPid(record.pid);
  cleanLock(record.pid);
  console.log('🛑 chat-cc 已强制停止 (SIGKILL)');
}

function status(): void {
  let record = readPid();
  if (!record || !isOwnedProcess(record)) {
    const lockOwner = readLockPid();
    if (lockOwner && isAlive(lockOwner) && isStartingCommand(processCommand(lockOwner))) {
      console.log(`chat-cc 正在启动 (pid: ${lockOwner})`);
      return;
    }
    const recovered = lockOwner ? ownedDaemonRecord(lockOwner) : undefined;
    if (recovered) {
      // pid 文件可能被外部清理，但 lock + 精确入口 + 进程启动时间
      // 足以证明 daemon 身份。恢复 pid 以免后续 start/status 误判。
      record = recovered;
      writePid(record);
    } else {
      console.log('chat-cc 未在运行');
      if (record) cleanPid(record.pid);
      return;
    }
  }

  const uptime = processUptime(record.pid);
  console.log(`chat-cc 运行中`);
  console.log(`  PID:    ${record.pid}`);
  if (uptime) console.log(`  运行:   ${uptime}`);
  console.log(`  日志:   ${logPath()}`);
  console.log(`  配置:   ${resolveConfigPath()}`);
}

function readPid(): PidRecord | undefined {
  const p = pidPath();
  if (!existsSync(p)) return undefined;
  try {
    const raw = readFileSync(p, 'utf8').trim();
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Partial<PidRecord>;
      return Number.isInteger(parsed.pid) && Number(parsed.pid) > 0
        ? {
            pid: Number(parsed.pid),
            ...(typeof parsed.startedAt === 'string' ? { startedAt: parsed.startedAt } : {}),
            ...(typeof parsed.entry === 'string' ? { entry: parsed.entry } : {}),
          }
        : undefined;
    }
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? { pid: n } : undefined;
  } catch {
    return undefined;
  }
}

function writePid(record: PidRecord): void {
  writeFileAtomicSync(pidPath(), JSON.stringify(record), { mode: 0o600 });
}

function cleanPid(expectedPid?: number): void {
  if (expectedPid !== undefined && readPid()?.pid !== expectedPid) return;
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
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function processRecord(pid: number, entry?: string): PidRecord {
  const startedAt = processStartToken(pid);
  return {
    pid,
    ...(startedAt ? { startedAt } : {}),
    ...(entry ? { entry } : {}),
  };
}

function isOwnedProcess(record: PidRecord): boolean {
  if (!isAlive(record.pid)) return false;
  const startedAt = processStartToken(record.pid);
  if (record.startedAt && startedAt && record.startedAt !== startedAt) return false;
  const command = processCommand(record.pid);
  if (command) {
    // JSON pid 记录匹配写入时的精确入口；旧版纯数字 pid 只接受当前安装的 main.js。
    // 不再用泛化的 "main.js" 标记，避免 PID 复用后误杀其他 Node 服务。
    return command.includes(record.entry ?? SERVER_ENTRY);
  }
  return Boolean(record.startedAt && startedAt && startedAt === record.startedAt);
}

function processStartToken(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function processCommand(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function acquireStartLock(): { acquired: true } | { acquired: false; ownerPid?: number } {
  const path = daemonLockPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid), 'utf8'); } finally { closeSync(fd); }
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const ownerPid = readLockPid();
      // open(O_EXCL) 与写入 PID 之间存在极短窗口。近期的空/半写锁一律视为
      // 正在启动，避免另一个 start/stop 把有效锁误删。
      if (!ownerPid && !isOwnerlessLockStale()) return { acquired: false };
      const pidRecord = readPid();
      const knownDaemon = Boolean(
        ownerPid &&
        ((pidRecord?.pid === ownerPid && isOwnedProcess(pidRecord)) || ownedDaemonRecord(ownerPid)),
      );
      const ownerCommand = ownerPid ? processCommand(ownerPid) : undefined;
      const starting = Boolean(ownerPid && isAlive(ownerPid) && isStartingCommand(ownerCommand));
      if (knownDaemon || starting) return { acquired: false, ...(ownerPid ? { ownerPid } : {}) };
      if (ownerPid) cleanLock(ownerPid);
      else try { unlinkSync(path); } catch { /* 下一轮重试 */ }
    }
  }
  return { acquired: false, ...(readLockPid() ? { ownerPid: readLockPid() } : {}) };
}

function rewriteLock(pid: number): void {
  writeFileSync(daemonLockPath(), String(pid), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(daemonLockPath(), 0o600); } catch { /* 尽力而为 */ }
}

function readLockPid(): number | undefined {
  try {
    const pid = Number(readFileSync(daemonLockPath(), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isStartingCommand(command: string | undefined): boolean {
  return Boolean(command && (command.includes('/cli/') || /(?:^|\s)chat-cc(?:\s|$)/.test(command)));
}

function isOwnerlessLockStale(): boolean {
  try {
    return Date.now() - statSync(daemonLockPath()).mtimeMs > 2_000;
  } catch {
    return false;
  }
}

function cleanLock(expectedPid?: number): void {
  if (expectedPid !== undefined && readLockPid() !== expectedPid) return;
  try { unlinkSync(daemonLockPath()); } catch { /* ok */ }
}

/** pid 文件缺失时，从运行锁持有者恢复可验证的 daemon 记录。 */
function ownedDaemonRecord(pid: number): PidRecord | undefined {
  const record = processRecord(pid, SERVER_ENTRY);
  return isOwnedProcess(record) ? record : undefined;
}

function waitUntilReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (err) reject(err);
      else resolveReady();
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const payload = message as { type?: string; message?: string };
      if (payload.type === 'ready') finish();
      else if (payload.type === 'startup-error') finish(new Error(payload.message || 'daemon 初始化失败'));
    };
    const onError = (err: Error) => finish(err);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`daemon 在就绪前退出 (code=${String(code)}, signal=${String(signal)})`));
    const timer = setTimeout(() => finish(new Error(`等待 daemon 就绪超时（${timeoutMs}ms）`)), timeoutMs);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function terminateProcess(pid: number, timeoutMs: number): Promise<void> {
  if (!isAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!isAlive(pid)) return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
