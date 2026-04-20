import type { CommandFn } from './types.js';
import { card, cardHeader, md, hr, btnRow, cmdBtn } from '../feishu/cards/base.js';

export const projectCommand: CommandFn = async (_args, meta, { cfg, replier }) => {
  const projects = cfg.projects;
  const keys = Object.keys(projects);

  if (keys.length === 0) {
    await replier.replyCard(meta.messageId, card(cardHeader('📂 项目别名', 'blue'), [
      md('**当前未配置任何项目别名**\n\n在 `config.yaml` 的 `projects` 段添加：\n```yaml\nprojects:\n  server: "/path/to/server"\n  web: "/path/to/web"\n```'),
    ]));
    return;
  }

  const lines = keys.map((k) => `• \`@${k}\` → \`${projects[k]}\``);
  await replier.replyCard(
    meta.messageId,
    card(cardHeader('📂 项目别名', 'blue'), [
      md(`共 **${keys.length}** 个别名\n\n${lines.join('\n')}`),
      hr(),
      md('**使用方式**\n`/ask @别名 <问题>`  或  `/session start @别名`'),
      hr(),
      btnRow([
        cmdBtn('📊 状态', 'status', ''),
        cmdBtn('📋 会话', 'session', 'list'),
        cmdBtn('❓ 帮助', 'help', ''),
      ]),
    ]),
  );
};
