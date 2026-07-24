import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageReceiptStore } from '../../src/feishu/message-receipts.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chatcc-receipts-'));
  path = join(dir, 'receipts.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('MessageReceiptStore', () => {
  it('同进程与重启后都拒绝重复 message_id', () => {
    const first = new MessageReceiptStore(path);
    expect(first.accept('om_1')).toBe(true);
    expect(first.accept('om_1')).toBe(false);
    const restored = new MessageReceiptStore(path);
    expect(restored.accept('om_1')).toBe(false);
  });

  it('revoke 后允许重试，且按上限淘汰最老项', () => {
    const store = new MessageReceiptStore(path, 2);
    store.accept('a');
    store.accept('b');
    store.accept('c');
    expect(new MessageReceiptStore(path, 2).accept('a')).toBe(true);
    store.revoke('c');
    expect(store.accept('c')).toBe(true);
  });
});
