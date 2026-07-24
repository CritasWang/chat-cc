import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { mediaDir } from '../paths.js';
import { log } from '../logger.js';

/**
 * 用户消息资源（图片/文件）下载 — 让会话能"看到"用户发的图和文件。
 *
 * 飞书 im.v1.messageResource.get 支持下载消息中的 image/file 资源（≤100MB）。
 * 落盘到 ~/.chat-cc/media/<messageId>/，把绝对路径写进 prompt 交给会话：
 * Claude 的 Read 工具原生读图，Codex 沙箱对全盘可读。
 * 不落到项目 cwd：避免污染 git 工作区，且同群多会话时无法确定目标项目。
 */

export interface MediaResult {
  kind: 'image' | 'file';
  /** 落盘后的绝对路径 */
  path: string;
  /** 展示名（文件为原始文件名，图片为生成名） */
  name: string;
}

interface ResourceSpec {
  /** messageResource.get 的 type 参数 */
  type: 'image' | 'file';
  key: string;
  name: string;
}

/** 消息 content JSON → 资源定位（纯函数，可单测） */
export function resolveResourceSpec(msgType: string, rawContent: string): ResourceSpec | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (msgType === 'image') {
    const key = typeof parsed['image_key'] === 'string' ? parsed['image_key'] : '';
    if (!key) return undefined;
    // 飞书图片资源无扩展名信息，统一 .png（Claude Read 按内容识别格式，扩展名仅作提示）
    return { type: 'image', key, name: `${key.slice(0, 24)}.png` };
  }
  if (msgType === 'file') {
    const key = typeof parsed['file_key'] === 'string' ? parsed['file_key'] : '';
    if (!key) return undefined;
    // basename 防御 file_name 携带路径分隔符（路径穿越）
    const rawName = typeof parsed['file_name'] === 'string' && parsed['file_name'] ? parsed['file_name'] : key;
    const name = basename(rawName) || key;
    return { type: 'file', key, name: extname(name) ? name : `${name}.bin` };
  }
  return undefined;
}

export async function fetchMessageMedia(
  client: Lark.Client,
  messageId: string,
  msgType: string,
  rawContent: string,
): Promise<MediaResult | undefined> {
  const spec = resolveResourceSpec(msgType, rawContent);
  if (!spec) return undefined;
  const dir = join(mediaDir(), messageId);
  const filePath = join(dir, spec.name);
  try {
    await mkdir(dir, { recursive: true });
    const resp = await client.im.v1.messageResource.get({
      params: { type: spec.type },
      path: { message_id: messageId, file_key: spec.key },
    });
    await resp.writeFile(filePath);
  } catch (err) {
    log().warn({ err, messageId, msgType, key: spec.key }, '消息资源下载失败');
    return undefined;
  }
  log().info({ messageId, msgType, path: filePath }, '消息资源已落盘');
  return { kind: spec.type, path: filePath, name: spec.name };
}

/** 资源消息 → 投递给会话的 prompt 文本 */
export function mediaPrompt(media: MediaResult): string {
  return media.kind === 'image'
    ? `[我发送了一张图片，已保存到本地: ${media.path}]\n请查看该图片，结合当前上下文处理。`
    : `[我发送了文件「${media.name}」，已保存到本地: ${media.path}]\n请按需读取该文件，结合当前上下文处理。`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 清理超过保留期的媒体目录（media/<messageId>/ 按目录 mtime 判定）。
 * 幂等且容错：单个目录失败只记日志，不影响其余清理。
 * @returns 删除的目录数
 */
export async function sweepExpiredMedia(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const root = mediaDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0; // 目录不存在 = 从未下载过，无需清理
  }
  const cutoff = Date.now() - retentionDays * DAY_MS;
  let removed = 0;
  for (const name of entries) {
    const dir = join(root, name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory() || s.mtimeMs >= cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log().warn({ err, dir }, '媒体目录清理失败（跳过）');
    }
  }
  if (removed > 0) log().info({ removed, retentionDays }, '过期媒体已清理');
  return removed;
}

/**
 * 启动媒体定期清理：启动即清一次，此后每天清一次。
 * @returns stop 函数（daemon 关闭时调用）
 */
export function startMediaSweeper(retentionDays: number): () => void {
  if (retentionDays <= 0) return () => {};
  void sweepExpiredMedia(retentionDays).catch((err) => log().warn({ err }, '媒体清理异常'));
  const timer = setInterval(
    () => void sweepExpiredMedia(retentionDays).catch((err) => log().warn({ err }, '媒体清理异常')),
    DAY_MS,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
