import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepExpiredMedia } from '../../src/feishu/media.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

describe('sweepExpiredMedia', () => {
  let home: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chatcc-media-'));
    prevEnv = process.env['CHAT_CC_HOME'];
    process.env['CHAT_CC_HOME'] = home;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env['CHAT_CC_HOME'];
    else process.env['CHAT_CC_HOME'] = prevEnv;
    await rm(home, { recursive: true, force: true });
  });

  async function makeMediaEntry(name: string, ageDays: number): Promise<void> {
    const dir = join(home, 'media', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.png'), 'x');
    const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    await utimes(dir, t, t);
  }

  it('删除超过保留期的目录，保留新目录', async () => {
    await makeMediaEntry('om_old', 10);
    await makeMediaEntry('om_new', 1);
    const removed = await sweepExpiredMedia(7);
    expect(removed).toBe(1);
    expect(await readdir(join(home, 'media'))).toEqual(['om_new']);
  });

  it('retentionDays=0 不清理', async () => {
    await makeMediaEntry('om_old', 100);
    expect(await sweepExpiredMedia(0)).toBe(0);
    expect(await readdir(join(home, 'media'))).toEqual(['om_old']);
  });

  it('media 目录不存在时安静返回 0', async () => {
    expect(await sweepExpiredMedia(7)).toBe(0);
  });
});
