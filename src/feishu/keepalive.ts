import { request as httpsRequest } from 'node:https';
import { log } from '../logger.js';

/**
 * WS 连接保活 — 多层防御（借鉴 lark-bridge）。
 *
 * 独立于 SDK 自身的 ping/reconnect 机制，从旁路检测「连接看似存在但已死」
 * 的场景（Mac 合盖睡眠唤醒、网络切换后 WS 卡死等）：
 *
 * 1. 15s 独立 interval，与 SDK 的 pingInterval 无关
 * 2. 睡眠检测：两次 tick 时间差 > 30s 视为机器睡过，重置计数不动作
 * 3. 计时风暴防护：唤醒后多个积压 interval 连续触发，间隔过短的 tick 跳过
 * 4. HTTP 探测：区分「网络不可达」（不重连，等网络恢复）vs「WS 卡死」（该重连）
 * 5. 计数防抖：连续 3 次检测到非 connected 且网络可达，才强制重连
 */

const KEEPALIVE_INTERVAL_MS = 15_000;
const SLEEP_DETECT_MS = 30_000;
const TIMER_STORM_GUARD_MS = 5_000;
const DEAD_THRESHOLD = 3;
const NETWORK_DOWN_LOG_EVERY = 20;
const PROBE_TIMEOUT_MS = 5_000;

export interface KeepaliveDeps {
  /** 返回 SDK WSClient 当前连接状态 */
  getState: () => 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  /** 强制重连（销毁旧连接并重建） */
  forceReconnect: () => Promise<void>;
  /** 探测目标域名，默认飞书开放平台 */
  probeHost?: string;
}

export interface KeepaliveHandle {
  stop(): void;
}

/** HTTP HEAD 探测：网络层是否可达（任何 HTTP 响应都算可达） */
function httpProbe(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      { host, method: 'HEAD', path: '/', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

export function startKeepalive(deps: KeepaliveDeps): KeepaliveHandle {
  const host = deps.probeHost ?? 'open.feishu.cn';
  let consecutiveDown = 0;
  let networkDownTicks = 0;
  let lastTickAt = Date.now();
  let reconnecting = false;

  const tick = async (): Promise<void> => {
    const now = Date.now();
    const sinceLast = now - lastTickAt;
    lastTickAt = now;

    // (2) 睡眠检测：间隔远超 interval，机器睡过 — 让 SDK 自身先恢复
    if (sinceLast > SLEEP_DETECT_MS) {
      log().info({ sleptMs: sinceLast }, 'keepalive: 检测到睡眠唤醒，重置计数');
      consecutiveDown = 0;
      return;
    }

    // (3) 计时风暴防护：唤醒后积压 interval 连续触发
    if (sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) return;

    const state = deps.getState();
    if (state === 'connected') {
      if (consecutiveDown > 0 || networkDownTicks > 0) {
        log().info('keepalive: 连接已恢复');
      }
      consecutiveDown = 0;
      networkDownTicks = 0;
      return;
    }

    // (4) 网络探测：不可达时不重连（重连也没用），等网络恢复
    const reachable = await httpProbe(host);
    if (!reachable) {
      networkDownTicks++;
      if (networkDownTicks === 1 || networkDownTicks % NETWORK_DOWN_LOG_EVERY === 0) {
        log().warn({ host, networkDownTicks }, 'keepalive: 网络不可达');
      }
      return;
    }
    networkDownTicks = 0;

    // (5) 防抖：网络可达但 WS 非 connected，连续 3 次才动手
    consecutiveDown++;
    log().warn({ state, consecutiveDown }, 'keepalive: WS 非连接状态');
    if (consecutiveDown >= DEAD_THRESHOLD && !reconnecting) {
      consecutiveDown = 0;
      reconnecting = true;
      log().warn({ state }, 'keepalive: 强制重连');
      try {
        await deps.forceReconnect();
        log().info('keepalive: 强制重连完成');
      } catch (err) {
        log().error({ err }, 'keepalive: 强制重连失败');
      } finally {
        reconnecting = false;
      }
    }
  };

  const timer = setInterval(() => {
    void tick().catch((err) => log().error({ err }, 'keepalive tick 异常'));
  }, KEEPALIVE_INTERVAL_MS);
  // 不阻止进程退出
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
