import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { resolveConfigPath } from '../config.js';
import { chatccHome } from '../paths.js';

interface Check {
  name: string;
  fn: () => { ok: boolean; detail: string };
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [
    {
      name: 'Node.js >= 20.11',
      fn: () => {
        const v = process.version;
        const [major, minor] = v.replace('v', '').split('.').map(Number);
        const ok = (major! > 20) || (major === 20 && (minor ?? 0) >= 11);
        return { ok, detail: ok ? v : `${v}（需要 >= 20.11）` };
      },
    },
    {
      name: 'claude CLI 可执行',
      fn: () => {
        try {
          const p = execSync('which claude 2>/dev/null || where claude 2>nul', { encoding: 'utf8' }).trim();
          return { ok: true, detail: p };
        } catch {
          return { ok: false, detail: '未找到（需安装 Claude Code CLI）' };
        }
      },
    },
    {
      name: '飞书 App ID 已配置',
      fn: () => {
        if (process.env['FEISHU_APP_ID']) return { ok: true, detail: '环境变量' };
        const cfgPath = resolveConfigPath();
        if (!existsSync(cfgPath)) return { ok: false, detail: '配置文件不存在' };
        try {
          const raw = parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
          return raw['app_id'] ? { ok: true, detail: '配置文件' } : { ok: false, detail: '未设置' };
        } catch {
          return { ok: false, detail: '配置文件解析失败' };
        }
      },
    },
    {
      name: '飞书 App Secret 已配置',
      fn: () => {
        if (process.env['FEISHU_APP_SECRET']) return { ok: true, detail: '环境变量' };
        const cfgPath = resolveConfigPath();
        if (!existsSync(cfgPath)) return { ok: false, detail: '配置文件不存在' };
        try {
          const raw = parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
          return raw['app_secret'] ? { ok: true, detail: '配置文件' } : { ok: false, detail: '未设置' };
        } catch {
          return { ok: false, detail: '配置文件解析失败' };
        }
      },
    },
    {
      name: '配置文件存在',
      fn: () => {
        const p = resolveConfigPath();
        return existsSync(p)
          ? { ok: true, detail: p }
          : { ok: false, detail: `${p}（运行 chat-cc init 生成）` };
      },
    },
    {
      name: '~/.chat-cc/ 目录存在',
      fn: () => {
        const h = chatccHome();
        return existsSync(h)
          ? { ok: true, detail: h }
          : { ok: false, detail: `${h}（运行 chat-cc init 自动创建）` };
      },
    },
  ];

  console.log('\n🏥 chat-cc 环境检查\n');
  console.log('检查项                          状态');
  console.log('────────────────────────────────────────');

  let allOk = true;
  for (const c of checks) {
    try {
      const r = c.fn();
      const icon = r.ok ? '✅' : '❌';
      if (!r.ok) allOk = false;
      console.log(`${icon} ${c.name.padEnd(28)} ${r.detail}`);
    } catch (err) {
      allOk = false;
      console.log(`❌ ${c.name.padEnd(28)} 检查异常: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log('');
  if (allOk) {
    console.log('✅ 所有检查通过');
  } else {
    console.log('⚠️  部分检查未通过，请根据提示修复');
  }
}
