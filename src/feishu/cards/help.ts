import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, cmdBtn, hr, md } from './base.js';

export function renderHelpCard(): InteractiveCard {
  return card(cardHeader('📋 ChatCC 命令手册', 'blue'), [
    md('**🎯 常用功能**'),
    btnRow([
      cmdBtn('📊 状态', 'status', ''),
      cmdBtn('📋 会话', 'session', 'list'),
      cmdBtn('💰 用量', 'usage', ''),
    ]),
    hr(),

    md(
      '**💬 会话交互**\n' +
        '`/s <消息>`  发送到活跃会话\n' +
        '`/session start [@别名]`  启动会话\n' +
        '`/session stop [threadKey]`  关闭\n' +
        '`/session list`  列出\n' +
        '`/stop`  精确中断当前会话',
    ),
    hr(),

    md(
      '**🤖 无状态问答**\n' +
        '`/ask <提示词>`  一次性问答\n' +
        '`/ask @别名 <提示词>`  指定项目目录',
    ),
    hr(),

    md(
      '**🛠 管理**\n' +
        '`/status`  系统状态\n' +
        '`/usage`  Token/Cost 看板\n' +
        '`/ping`  健康检查',
    ),
    hr(),

    md('*📺 实况转播自动运行 · 卡片按钮直接触发 · 直接发消息=发到活跃会话 · /help <命令> 查看详情*'),
  ]);
}
