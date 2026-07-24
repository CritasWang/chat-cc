import type { CommandFn } from './types.js';
import { card, cardHeader, md, hr, btnRow, cmdBtn, toastBtn } from '../feishu/cards/base.js';
import { replyOptions } from '../feishu/router.js';

export const projectCommand: CommandFn = async (_args, meta, { cfg, replier }) => {
  const projects = cfg.projects;
  const keys = Object.keys(projects);

  if (keys.length === 0) {
    await replier.replyCard(meta.messageId, card(cardHeader('📂 项目别名', 'blue'), [
      md('**当前未配置任何项目别名**\n\n在 `config.yaml` 的 `projects` 段添加：\n```yaml\nprojects:\n  server: "/path/to/server"\n  web: "/path/to/web"\n```'),
    ]), replyOptions(meta));
    return;
  }

  const elements: unknown[] = [];
  elements.push(md(`共 **${keys.length}** 个项目别名`));
  elements.push(hr());

  // 每个项目一行 markdown + 一行按钮（2 个），飞书卡片对按钮总数有限制
  const MAX_INLINE = 8;
  const inlineKeys = keys.slice(0, MAX_INLINE);

  for (const k of inlineKeys) {
    elements.push(md(`**@${k}** · \`${projects[k]}\``));
    elements.push(btnRow([
      cmdBtn('🚀 开启会话', 'session', `start @${k}`),
      // 卡片按钮无法在命令尾部追加自由文本；直接 dispatch `/ask @alias`
      // 会把 alias 本身当成问题发给 Agent。改为明确的输入指引。
      toastBtn('🤖 提问', `请发送：/ask @${k} <问题>`),
    ]));
  }

  if (keys.length > MAX_INLINE) {
    elements.push(hr());
    const rest = keys.slice(MAX_INLINE).map((k) => `\`@${k}\``).join(' · ');
    elements.push(md(`更多别名: ${rest}\n使用 \`/session start @别名\` 访问`));
  }

  await replier.replyCard(meta.messageId, card(cardHeader('📂 项目别名', 'blue'), elements), replyOptions(meta));
};
