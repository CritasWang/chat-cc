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

  const elements: unknown[] = [];
  elements.push(md(`共 **${keys.length}** 个项目别名`));
  elements.push(hr());

  for (const k of keys) {
    elements.push(md(`**@${k}**\n\`${projects[k]}\``));
    elements.push(btnRow([
      cmdBtn(`🚀 开启会话`, 'session', `start @${k}`),
      cmdBtn(`🤖 提问`, 'ask', `@${k} `),
    ]));
    elements.push(hr());
  }

  elements.push(md('*使用 `/ask @别名 <问题>` 或 `/session start @别名` 快速访问*'));

  await replier.replyCard(meta.messageId, card(cardHeader('📂 项目别名', 'blue'), elements));
};
