import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../logger.js';

const exec = promisify(execFile);

/**
 * /new chat 建群后自动打「会话标签」（feed 标签，如 ai cc / ai codex）。
 *
 * 约束：feed.groups.* 全系 **user_access_token only**（bot 的 tenant token
 * 会被拒绝），chat-cc 只持有 bot 凭据 —— 因此借道本机 lark-cli 的用户身份，
 * best-effort 执行：lark-cli 不存在 / 未授权 / 缺 im:feed_group_v1 权限时
 * 静默跳过，不影响建群本身。
 *
 * 标签按名字查找，不存在则创建（type=normal，成员显式管理）。
 */

const EXEC_OPTS = { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 } as const;

export interface FeedTagResult {
  ok: boolean;
  detail: string;
}

/** 名称 → feed_group_id 进程内缓存（标签一般不会被删，缓存终身有效） */
const groupIdCache = new Map<string, string>();

export async function applyFeedTag(
  bin: string,
  tagName: string,
  chatId: string,
): Promise<FeedTagResult> {
  try {
    const groupId = await findOrCreateGroup(bin, tagName);
    if (!groupId) return { ok: false, detail: `标签「${tagName}」查找/创建失败` };

    const { stdout } = await exec(
      bin,
      [
        'im', 'feed.groups', 'batch_add_item',
        '--feed-group-id', groupId,
        '--data', JSON.stringify({ items: [{ feed_id: chatId, feed_type: 'chat' }] }),
        '--as', 'user',
        '--format', 'json',
      ],
      EXEC_OPTS,
    );
    const resp = parseJson(stdout);
    if (resp?.['ok'] === false) {
      return { ok: false, detail: extractError(resp) };
    }
    log().info({ tagName, chatId, groupId }, '新群已打会话标签');
    return { ok: true, detail: tagName };
  } catch (err) {
    const detail = summarizeExecError(err);
    log().warn({ err: detail, tagName, chatId }, '打会话标签失败（已跳过）');
    return { ok: false, detail };
  }
}

/** 批量打多个标签（如 ai + cc）；逐个 best-effort，汇总成败 */
export async function applyFeedTags(
  bin: string,
  tagNames: string[],
  chatId: string,
): Promise<FeedTagResult> {
  const okNames: string[] = [];
  const failures: string[] = [];
  for (const name of tagNames) {
    const r = await applyFeedTag(bin, name, chatId);
    if (r.ok) okNames.push(name);
    else failures.push(`${name}: ${r.detail}`);
  }
  if (failures.length === 0) return { ok: true, detail: okNames.join('、') };
  if (okNames.length === 0) return { ok: false, detail: failures.join('；') };
  return { ok: true, detail: `${okNames.join('、')}（部分失败：${failures.join('；')}）` };
}

/** 把群从某标签移除（标签不存在视为成功） */
export async function removeFeedTag(
  bin: string,
  tagName: string,
  chatId: string,
): Promise<FeedTagResult> {
  try {
    const groupId = await findGroup(bin, tagName);
    if (!groupId) return { ok: true, detail: `标签「${tagName}」不存在，无需移除` };
    const { stdout } = await exec(
      bin,
      [
        'im', 'feed.groups', 'batch_remove_item',
        '--feed-group-id', groupId,
        '--data', JSON.stringify({ items: [{ feed_id: chatId, feed_type: 'chat' }] }),
        '--as', 'user',
        '--format', 'json',
      ],
      EXEC_OPTS,
    );
    const resp = parseJson(stdout);
    if (resp?.['ok'] === false) return { ok: false, detail: extractError(resp) };
    log().info({ tagName, chatId, groupId }, '群已移除会话标签');
    return { ok: true, detail: tagName };
  } catch (err) {
    const detail = summarizeExecError(err);
    log().warn({ err: detail, tagName, chatId }, '移除会话标签失败（已跳过）');
    return { ok: false, detail };
  }
}

/** 仅查找标签（不创建） */
async function findGroup(bin: string, tagName: string): Promise<string | undefined> {
  const cached = groupIdCache.get(tagName);
  if (cached) return cached;
  const { stdout } = await exec(
    bin,
    ['im', '+feed-group-list', '--page-all', '--as', 'user', '--format', 'json'],
    EXEC_OPTS,
  );
  const found = findGroupIdByName(parseJson(stdout), tagName);
  if (found) groupIdCache.set(tagName, found);
  return found;
}

async function findOrCreateGroup(bin: string, tagName: string): Promise<string | undefined> {
  const cached = groupIdCache.get(tagName);
  if (cached) return cached;

  // 1. 查找已有标签
  const { stdout: listOut } = await exec(
    bin,
    ['im', '+feed-group-list', '--page-all', '--as', 'user', '--format', 'json'],
    EXEC_OPTS,
  );
  const found = findGroupIdByName(parseJson(listOut), tagName);
  if (found) {
    groupIdCache.set(tagName, found);
    return found;
  }

  // 2. 不存在则创建（normal 类型，显式管理成员）
  const { stdout: createOut } = await exec(
    bin,
    [
      'im', 'feed.groups', 'create',
      '--data', JSON.stringify({ feed_group_creator: { name: tagName, type: 'normal' } }),
      '--as', 'user',
      '--format', 'json',
    ],
    EXEC_OPTS,
  );
  const created = firstGroupId(parseJson(createOut));
  if (created) {
    groupIdCache.set(tagName, created);
    log().info({ tagName, groupId: created }, '会话标签不存在，已创建');
  }
  return created;
}

/** 递归找 name 匹配的对象里的 ofg_ id */
function findGroupIdByName(obj: unknown, name: string): string | undefined {
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const hit = findGroupIdByName(x, name);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  if (rec['name'] === name) {
    const id = firstGroupId(rec);
    if (id) return id;
  }
  for (const v of Object.values(rec)) {
    const hit = findGroupIdByName(v, name);
    if (hit) return hit;
  }
  return undefined;
}

/** 递归找第一个 ofg_ 开头的字符串（标签 id 形如 ofg_xxx） */
function firstGroupId(obj: unknown): string | undefined {
  if (typeof obj === 'string') return obj.startsWith('ofg_') ? obj : undefined;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const hit = firstGroupId(x);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  for (const v of Object.values(obj)) {
    const hit = firstGroupId(v);
    if (hit) return hit;
  }
  return undefined;
}

function parseJson(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function extractError(resp: Record<string, unknown>): string {
  const err = resp['error'];
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return String(e['message'] ?? e['subtype'] ?? e['type'] ?? '未知错误');
  }
  return '未知错误';
}

function summarizeExecError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOENT')) return 'lark-cli 未安装';
  if (msg.includes('missing_scope') || msg.includes('im:feed_group')) return 'lark-cli 缺少 im:feed_group_v1 权限';
  return msg.slice(0, 200);
}
