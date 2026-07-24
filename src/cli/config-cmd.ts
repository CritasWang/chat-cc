import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CONFIG_KEYS, parseConfig, resolveConfigPath } from '../config.js';
import { writeFileAtomicSync } from '../platform/atomic-write.js';

export async function runConfigCmd(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'path') {
    console.log(resolveConfigPath());
    return;
  }

  if (sub === 'edit') {
    const cfgPath = resolveConfigPath();
    const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';
    let child;
    try {
      child = spawn(editor, [cfgPath], { stdio: 'inherit' });
    } catch (err) {
      console.error(`无法启动编辑器 ${editor}: ${(err as Error).message}`);
      process.exit(1);
    }
    child.on('error', (err) => {
      console.error(`编辑器异常: ${err.message}（尝试 EDITOR=${editor}）`);
      process.exit(1);
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    if (code !== 0) {
      console.error(`编辑器退出码异常: ${String(code)}`);
      process.exitCode = 1;
    }
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

    if (!CONFIG_KEYS.has(key)) {
      console.error(`未知配置项: ${key}（严格模式下拒绝写入）`);
      process.exitCode = 1;
      return;
    }

    let parsed: unknown = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) parsed = Number(value);
    else if (value.startsWith('[') || value.startsWith('{')) {
      try { parsed = JSON.parse(value); } catch { /* keep as string */ }
    }

    const next = { ...raw, [key]: parsed };
    try {
      parseConfig(next);
    } catch (err) {
      console.error(`配置值无效: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    writeFileAtomicSync(cfgPath, stringifyYaml(next), { mode: 0o600 });
    const shown = key === 'app_secret' ? '"<redacted>"' : JSON.stringify(parsed);
    console.log(`✅ ${key} = ${shown}`);
    return;
  }

  console.error('用法: chat-cc config <get|set|edit|path>');
  process.exit(1);
}
