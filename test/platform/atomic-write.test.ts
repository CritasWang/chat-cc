import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writeFileAtomicSync } from '../../src/platform/atomic-write.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('写入内容并可读回', async () => {
    const p = join(dir, 'a.json');
    await writeFileAtomic(p, '{"x":1}');
    expect(readFileSync(p, 'utf8')).toBe('{"x":1}');
  });

  it('覆盖已有文件（原子替换）', async () => {
    const p = join(dir, 'a.json');
    await writeFileAtomic(p, 'old');
    await writeFileAtomic(p, 'new');
    expect(readFileSync(p, 'utf8')).toBe('new');
  });

  it('自动创建父目录', async () => {
    const p = join(dir, 'sub', 'deep', 'a.json');
    await writeFileAtomic(p, 'x');
    expect(readFileSync(p, 'utf8')).toBe('x');
  });

  it('默认权限 0600', async () => {
    const p = join(dir, 'a.json');
    await writeFileAtomic(p, 'x');
    // Windows 无 POSIX 权限位，跳过
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it('不残留临时文件', async () => {
    const p = join(dir, 'a.json');
    await writeFileAtomic(p, 'x');
    await writeFileAtomic(p, 'y');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
});

describe('writeFileAtomicSync', () => {
  it('写入内容并可读回', () => {
    const p = join(dir, 'b.json');
    writeFileAtomicSync(p, '{"y":2}');
    expect(readFileSync(p, 'utf8')).toBe('{"y":2}');
  });

  it('覆盖已有文件且不残留临时文件', () => {
    const p = join(dir, 'b.json');
    writeFileAtomicSync(p, 'old');
    writeFileAtomicSync(p, 'new');
    expect(readFileSync(p, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['b.json']);
  });

  it('支持 Buffer 输入', () => {
    const p = join(dir, 'c.bin');
    writeFileAtomicSync(p, Buffer.from([1, 2, 3]));
    expect([...readFileSync(p)]).toEqual([1, 2, 3]);
  });
});
