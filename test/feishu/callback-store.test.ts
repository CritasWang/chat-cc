import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallbackStore } from '../../src/feishu/callback-store.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callback-store-'));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('CallbackStore.dedupe 短窗口去重', () => {
  it('首次放行，TTL 内重复拒绝', () => {
    const store = new CallbackStore(undefined, 3000);
    expect(store.dedupe('k1', 1000)).toBe(true);
    expect(store.dedupe('k1', 2000)).toBe(false);
    expect(store.dedupe('k1', 3500)).toBe(false); // 3500-2000 未过？— dedupe 记录的是首次时间
  });

  it('TTL 过后重新放行', () => {
    const store = new CallbackStore(undefined, 3000);
    expect(store.dedupe('k1', 1000)).toBe(true);
    expect(store.dedupe('k1', 5000)).toBe(true);
  });

  it('不同 key 互不影响', () => {
    const store = new CallbackStore(undefined, 3000);
    expect(store.dedupe('k1', 1000)).toBe(true);
    expect(store.dedupe('k2', 1000)).toBe(true);
  });
});

describe('CallbackStore.consume 一次性 nonce', () => {
  it('首次 consume 成功，重复拒绝', () => {
    const store = new CallbackStore();
    expect(store.consume('n1')).toBe(true);
    expect(store.consume('n1')).toBe(false);
  });

  it('revoke 后可再次 consume', () => {
    const store = new CallbackStore();
    expect(store.consume('n1')).toBe(true);
    store.revoke('n1');
    expect(store.consume('n1')).toBe(true);
  });

  it('持久化后新实例仍拒绝已消费 nonce', async () => {
    const p = join(dir, 'nonces.json');
    const store = new CallbackStore(p);
    store.consume('n1');
    store.consume('n2');
    await vi.advanceTimersByTimeAsync(300); // 触发防抖落盘
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(['n1', 'n2']);

    const store2 = new CallbackStore(p);
    expect(store2.consume('n1')).toBe(false);
    expect(store2.consume('n3')).toBe(true);
  });

  it('损坏的持久化文件不影响启动', () => {
    const p = join(dir, 'bad.json');
    // 先写坏文件
    const store = new CallbackStore(p);
    expect(store.consume('x')).toBe(true);
  });
});
