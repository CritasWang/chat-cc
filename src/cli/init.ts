import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import * as readline from 'node:readline';
import { stringify as stringifyYaml } from 'yaml';
import { chatccHome, configPath } from '../paths.js';
import { writeFileAtomicSync } from '../platform/atomic-write.js';

export async function runInit(_args: string[]): Promise<void> {
  const home = chatccHome();
  const cfgFile = configPath();

  if (existsSync(cfgFile)) {
    const overwrite = await ask('⚠️  配置文件已存在，是否覆盖？(y/N) ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('跳过初始化');
      return;
    }
  }

  console.log('\n🔧 chat-cc 配置向导\n');

  const appId = await ask('飞书 App ID: ');
  const appSecret = await askSecret('飞书 App Secret: ');
  const defaultCwd = await ask(`默认工作目录 (${process.env['HOME'] || '~'}): `) || process.env['HOME'] || '~';
  const dangerRaw = await ask('开启 danger 模式（跳过权限审批）？(y/N) ');
  const danger = dangerRaw.toLowerCase() === 'y';
  const allowAllRaw = await ask('允许所有能联系机器人的用户使用？强烈不推荐 (y/N) ');
  const allowAll = allowAllRaw.toLowerCase() === 'y';
  const allowedUsers = allowAll ? [] : parseCsv(await ask('允许的用户 open_id（逗号分隔，例 ou_xxx）: '));
  const allowedChats = allowAll ? [] : parseCsv(await ask('允许的群 chat_id（可留空，逗号分隔）: '));
  const adminUsers = parseCsv(await ask('管理员 open_id（可执行 danger/reload/profile，逗号分隔）: '));

  const projects: Record<string, string> = {};
  const addProjects = await ask('配置项目别名？(y/N) ');
  if (addProjects.toLowerCase() === 'y') {
    console.log('输入 "别名 路径" 格式（一行一个，空行结束）:');
    while (true) {
      const line = await ask('  ');
      if (!line.trim()) break;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        projects[parts[0]!] = parts.slice(1).join(' ');
      }
    }
  }

  const yaml =
    '# chat-cc 配置文件\n' +
    '# 默认 fail-closed；只有 allow_all_users=true 或命中 allowed_users/allowed_chats 才能使用。\n\n' +
    stringifyYaml({
      app_id: appId,
      app_secret: appSecret,
      allow_all_users: allowAll,
      allowed_users: allowedUsers,
      allowed_chats: allowedChats,
      admin_users: adminUsers,
      default_cwd: defaultCwd,
      projects,
      allowed_cwd_roots: [],
      claude_danger_mode: danger,
      claude_allowed_tools: ['Read', 'Glob', 'Grep'],
      max_active_sessions: 20,
      idle_timeout_minutes: 30,
      log_level: 'info',
    }, { lineWidth: 0 });

  mkdirSync(home, { recursive: true, mode: 0o700 });
  try { chmodSync(home, 0o700); } catch { /* best-effort */ }
  writeFileAtomicSync(cfgFile, yaml, { mode: 0o600 });

  console.log(`\n✅ 配置已写入 ${cfgFile}`);
  console.log('💡 运行 chat-cc start 启动服务');
  console.log('💡 运行 chat-cc doctor 检查环境');
}

function parseCsv(raw: string): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** readline 没有公开的 silent question API；仅在输入阶段抑制字符回显。 */
function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return ask(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const mutable = rl as typeof rl & { _writeToOutput?: (text: string) => void };
  const original = mutable._writeToOutput?.bind(rl);
  let muted = false;
  if (original) {
    mutable._writeToOutput = (text: string) => {
      if (!muted) original(text);
    };
  }
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}
