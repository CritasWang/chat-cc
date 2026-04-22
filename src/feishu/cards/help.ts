import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, cmdBtn, hr, md } from './base.js';

export function renderHelpCard(): InteractiveCard {
  return card(cardHeader('📋 命令手册', 'blue'), [
    md('**🎯 常用功能**'),
    btnRow([
      cmdBtn('📊 状态', 'status', ''),
      cmdBtn('📂 项目', 'project', ''),
    ]),
    btnRow([
      cmdBtn('📋 会话', 'session', 'list'),
      cmdBtn('💰 用量', 'usage', ''),
    ]),
    hr(),

    md(
      '**💬 会话交互（支持多会话并存）**\n' +
        '`/s <消息>`  发送到当前活跃会话\n' +
        '`/session start [@别名|path]`  新建/激活一个 slot（自动取别名或路径 basename 为 slot 名）\n' +
        '`/session switch <slot名|序号>`  在已有会话之间切换，**其他会话仍在后台运行**\n' +
        '`/session current`  查看当前活跃会话\n' +
        '`/session list`  列出所有会话（每行带 ▶ 激活按钮）\n' +
        '`/session stop [slot名|序号]`  关闭指定会话，不传=关当前\n' +
        '`/stop`  中断当前会话的本轮任务\n' +
        '\n*同一群同一用户可开 N 个会话 slot；在 list 卡片点 ▶ 激活即可切换*',
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
        '`/status`  系统状态  ·  `/project`  项目别名\n' +
        '`/danger on|off`  权限模式  ·  `/reload`  热重载配置\n' +
        '`/usage`  Token/Cost 看板  ·  `/ping`  健康检查',
    ),
    hr(),

    btnRow([
      cmdBtn('⚡ Danger', 'danger', ''),
      cmdBtn('♻️ 重载', 'reload', ''),
    ]),
    hr(),

    md('*📺 实况转播自动运行 · 卡片按钮直接触发 · 直接发消息=发到活跃会话 · /help <命令> 查看详情*'),
  ]);
}
