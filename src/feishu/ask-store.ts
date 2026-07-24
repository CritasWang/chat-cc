import { log } from '../logger.js';
import type { AskCardState } from './cards/ask-user.js';

/**
 * AskUserQuestion 卡片状态注册表：messageId → 状态。
 *
 * 提问卡片发出后注册；用户点选/提交时由 card-action 按 messageId 取回、
 * 更新并原地 PATCH 卡片。内存态即可 —— 进程重启后旧提问卡的按钮会提示
 * 已失效（引导直接发消息回答），符合「审批过期」同类语义。
 */

const MAX_ENTRIES = 200;

const store = new Map<string, AskCardState>();

export function registerAskCard(messageId: string, state: AskCardState): void {
  store.set(messageId, state);
  // 防无限增长：超限淘汰最老的
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      store.delete(oldest);
      log().debug({ messageId: oldest }, 'ask-store 淘汰最老提问卡');
    }
  }
}

export function getAskCard(messageId: string): AskCardState | undefined {
  return store.get(messageId);
}

export function removeAskCard(messageId: string): void {
  store.delete(messageId);
}
