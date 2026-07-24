import type { Config } from '../config.js';

/**
 * 敏感命令特权判定（/danger、/reload、/profile use）。
 *
 * 只依赖 config `admin_users`，不调用任何飞书管理类 API：
 * 曾经的「应用 owner 自动识别」需要 admin:app.info:readonly 这种
 * 管理员级敏感权限，代价过重，已移除。
 *
 * - admin_users 配置了 → 仅列表内 open_id 可执行敏感命令
 * - admin_users 为空 → 无人可执行敏感命令（fail-closed）
 */
export function isPrivileged(cfg: Pick<Config, 'admin_users'>, senderId: string): boolean {
  return cfg.admin_users.includes(senderId);
}
