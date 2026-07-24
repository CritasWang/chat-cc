import type { Replier } from './replier.js';

/**
 * chatId → 群名缓存（状态卡/会话列表把裸 oc_xxx 换成可读群名用）。
 * 失败也缓存（占位名），避免每次渲染都打 API；TTL 后自动重查。
 */
const TTL_MS = 10 * 60_000;
const MAX_CACHE_SIZE = 1_000;

export class ChatNameCache {
  private readonly cache = new Map<string, { name: string; at: number }>();

  constructor(private readonly replier: Replier) {}

  async resolve(chatId: string): Promise<string> {
    const hit = this.cache.get(chatId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
    const info = await this.replier.getChatInfo(chatId);
    // p2p 单聊无群名；查询失败给尾缀占位便于区分
    const name = info?.name || `单聊/未知(…${chatId.slice(-6)})`;
    this.cache.delete(chatId);
    this.cache.set(chatId, { name, at: Date.now() });
    while (this.cache.size > MAX_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
    return name;
  }

  async resolveAll(chatIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      [...new Set(chatIds)].map(async (id) => {
        out.set(id, await this.resolve(id));
      }),
    );
    return out;
  }
}
