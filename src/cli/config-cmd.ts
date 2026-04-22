import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveConfigPath } from '../config.js';

export async function runConfigCmd(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'path') {
    console.log(resolveConfigPath());
    return;
  }

  if (sub === 'edit') {
    const cfgPath = resolveConfigPath();
    const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';
    const child = spawn(editor, [cfgPath], { stdio: 'inherit' });
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    return;
  }

  if (sub === 'get') {
    const key = args[1];
    if (!key) {
      console.error('用法: chat-cc config get <key>');
      process.exit(1);
    }
    const cfgPath = resolveConfigPath();
    if (!existsSync(cfgPath)) {
      console.error(`配置文件不存在: ${cfgPath}`);
      process.exit(1);
    }
    const raw = parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const val = raw[key];
    if (val === undefined) {
      console.error(`未找到配置项: ${key}`);
      process.exit(1);
    }
    console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val));
    return;
  }

  if (sub === 'set') {
    const key = args[1];
    const value = args.slice(2).join(' ');
    if (!key || !value) {
      console.error('用法: chat-cc config set <key> <value>');
      process.exit(1);
    }
    const cfgPath = resolveConfigPath();
    if (!existsSync(cfgPath)) {
      console.error(`配置文件不存在: ${cfgPath}\n运行 chat-cc init 初始化`);
      process.exit(1);
    }
    const raw = parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;

    const KNOWN_KEYS = new Set([
      'app_id', 'app_secret', 'allowed_users', 'allowed_chats',
      'default_cwd', 'projects', 'claude_allowed_tools', 'claude_danger_mode',
      'claude_ask_timeout_min', 'claude_session_timeout_min', 'max_chunk_size',
      'shell_whitelist', 'notify_chat_id', 'status_push_interval_min',
      'status_push_chat_id', 'stream_throttle_ms', 'persistence_dir',
      'idle_timeout_minutes', 'idle_check_seconds', 'approval_timeout_ms',
      'auto_approve_tools', 'mcp_feishu_rate_limit_ms', 'log_level',
    ]);
    if (!KNOWN_KEYS.has(key)) {
      console.warn(`⚠️  未知配置项: ${key}（仍将写入）`);
    }

    let parsed: unknown = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) parsed = Number(value);
    else if (value.startsWith('[')) {
      try { parsed = JSON.parse(value); } catch { /* keep as string */ }
    }

    raw[key] = parsed;
    writeFileSync(cfgPath, stringifyYaml(raw), 'utf8');
    console.log(`✅ ${key} = ${JSON.stringify(parsed)}`);
    return;
  }

  console.error('用法: chat-cc config <get|set|edit|path>');
  process.exit(1);
}
