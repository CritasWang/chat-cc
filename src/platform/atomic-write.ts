import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { chmod, mkdir, open, rm, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * 原子化文件写入 — 防止进程崩溃/断电导致文件损坏。
 *
 * 严格顺序：写临时文件 → fsync → chmod → rename（原子替换）→ 目录 fsync。
 * 临时文件名包含 PID + 随机数，避免多进程并发写同一目标时互相覆盖。
 * rename 遇到 EPERM/EBUSY（Windows 反病毒/索引器占用）时重试。
 */

export interface AtomicWriteOptions {
  /** 文件权限，默认 0o600（含 token/session 数据，不给组/其他读） */
  mode?: number;
  maxRenameAttempts?: number;
  retryDelayMs?: number;
}

const DEFAULT_RENAME_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 25;

function tmpPathOf(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`,
  );
}

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

/** Windows 上部分文件系统对已打开句柄 fsync 会报 EPERM，可安全忽略 */
function isIgnorableFsyncError(err: unknown): boolean {
  return (
    process.platform === 'win32' &&
    (err as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
  );
}

export async function writeFileAtomic(
  path: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const mode = opts.mode ?? 0o600;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = tmpPathOf(path);
  try {
    const handle = await open(tmp, 'w', mode);
    try {
      await handle.writeFile(data);
      try {
        await handle.sync();
      } catch (err) {
        if (!isIgnorableFsyncError(err)) throw err;
      }
    } finally {
      await handle.close();
    }
    await chmod(tmp, mode);
    await renameWithRetry(tmp, path, opts);
    await fsyncDir(dirname(path));
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** 同步版本 — 供 Persistence 等同步调用点使用，语义与异步版一致 */
export function writeFileAtomicSync(
  path: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const mode = opts.mode ?? 0o600;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = tmpPathOf(path);
  try {
    const fd = openSync(tmp, 'w', mode);
    try {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      // writeSync 允许部分写入；writeFileSync(fd, ...) 会完整写完缓冲区。
      writeFileSync(fd, buf);
      try {
        fsyncSync(fd);
      } catch (err) {
        if (!isIgnorableFsyncError(err)) throw err;
      }
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    renameWithRetrySync(tmp, path, opts);
    fsyncDirSync(dirname(path));
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败忽略 */
    }
    throw err;
  }
}

async function renameWithRetry(
  from: string,
  to: string,
  opts: AtomicWriteOptions,
): Promise<void> {
  const maxAttempts = opts.maxRenameAttempts ?? DEFAULT_RENAME_ATTEMPTS;
  const delayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err) || attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

function renameWithRetrySync(from: string, to: string, opts: AtomicWriteOptions): void {
  const maxAttempts = opts.maxRenameAttempts ?? DEFAULT_RENAME_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err) || attempt === maxAttempts) break;
      // 同步路径极少触发重试（EPERM/EBUSY 基本只出现在 Windows），短忙等可接受
      const until = Date.now() + (opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * attempt;
      while (Date.now() < until) {
        /* busy-wait */
      }
    }
  }
  throw lastErr;
}

async function fsyncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // 目录 fsync 各平台支持不一，尽力而为
  }
}

function fsyncDirSync(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // 尽力而为
  }
}
