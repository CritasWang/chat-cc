import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { chatccHome, configPath } from '../paths.js';

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
  const appSecret = await ask('飞书 App Secret: ');
  const defaultCwd = await ask(`默认工作目录 (${process.env['HOME'] || '~'}): `) || process.env['HOME'] || '~';
  const dangerRaw = await ask('开启 danger 模式（跳过权限审批）？(y/N) ');
  const danger = dangerRaw.toLowerCase() === 'y';

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

  let projectsYaml = '';
  if (Object.keys(projects).length > 0) {
    projectsYaml = '\nprojects:\n' + Object.entries(projects)
      .map(([k, v]) => `  ${k}: "${v}"`)
      .join('\n');
  } else {
    projectsYaml = '\nprojects: {}';
  }

  const yaml = `# chat-cc 配置文件
# 也可通过环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 设置

app_id: "${appId}"
app_secret: "${appSecret}"

# 安全控制（留空=允许所有人）
allowed_users: []
allowed_chats: []

# Claude Code 配置
default_cwd: "${defaultCwd}"
claude_danger_mode: ${danger}

# 工具白名单（非 danger 模式时生效）
claude_allowed_tools:
  - "Read"
  - "Glob"
  - "Grep"

# 项目别名（使用 @别名 快捷访问）${projectsYaml}

# 日志级别: debug, info, warn, error
log_level: "info"

# 会话空闲超时（分钟，0=不超时）
idle_timeout_minutes: 30
`;

  mkdirSync(home, { recursive: true });
  writeFileSync(cfgFile, yaml, 'utf8');

  console.log(`\n✅ 配置已写入 ${cfgFile}`);
  console.log('💡 运行 chat-cc start 启动服务');
  console.log('💡 运行 chat-cc doctor 检查环境');
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
