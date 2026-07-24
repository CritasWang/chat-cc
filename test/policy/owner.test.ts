import { describe, it, expect } from 'vitest';
import { isPrivileged } from '../../src/policy/owner.js';

describe('isPrivileged 特权判定（仅 admin_users，无飞书管理 API 依赖）', () => {
  it('admin_users 为空 → fail-closed，无人拥有特权', () => {
    expect(isPrivileged({ admin_users: [] }, 'ou_anyone')).toBe(false);
    expect(isPrivileged({ admin_users: [] }, '')).toBe(false);
  });

  it('admin_users 命中允许', () => {
    expect(isPrivileged({ admin_users: ['ou_admin'] }, 'ou_admin')).toBe(true);
    expect(isPrivileged({ admin_users: ['ou_a', 'ou_b'] }, 'ou_b')).toBe(true);
  });

  it('admin_users 配置后未命中拒绝', () => {
    expect(isPrivileged({ admin_users: ['ou_admin'] }, 'ou_other')).toBe(false);
    expect(isPrivileged({ admin_users: ['ou_admin'] }, '')).toBe(false);
  });
});
