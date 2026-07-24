import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, cmdBtn, cmdBtnRefresh, hr, md } from './base.js';

export function renderHelpCard(): InteractiveCard {
  return card(cardHeader('📋 命令手册', 'blue'), [
    md('**🎯 常用操作**'),
    btnRow([
      cmdBtnRefresh('📊 状态', 'status', '', 'status', 'primary'),
      cmdBtn('📋 会话列表', 'session', 'list'),
    ]),
    btnRow([
      cmdBtn('🧹 清空上下文', 'clear', ''),
      cmdBtn('⏹ 中断当前', 'stop', '', 'danger'),
    ]),
    btnRow([
      cmdBtn('🛡 权限状态', 'danger', ''),
      cmdBtn('🔑 API Profile', 'profile', 'list'),
    ]),
    btnRow([
      cmdBtn('📂 项目', 'project', ''),
      cmdBtn('💰 用量', 'usage', ''),
    ]),
    hr(),

    md(
      '**💬 会话交互（支持多会话并存）**\n' +
        '`/s <消息>`  发送到当前活跃会话\n' +
        '`/new chat [名字] [@别名|/路径] [--topic] [--codex|--claude] [--profile <name>]`  自动建新群并开好会话\n' +
        '`/session start [@别名|path] [--codex|--claude] [--profile <name>]`  新建/激活一个 slot\n' +
        '`/session switch <slot名|序号>`  在已有会话之间切换，**其他会话仍在后台运行**\n' +
        '`/session current`  查看当前活跃会话\n' +
        '`/session list`  列出所有会话（每行带 ▶ 激活按钮）\n' +
        '`/session stop [slot名|序号]`  关闭指定会话，不传=关当前\n' +
        '`/cd <@别名|路径>`  当前会话切换工作目录（新目录开新对话）\n' +
        '`/clear`  清空当前会话上下文原地重开（设置保留）\n' +
        '`/stop`  中断当前会话的本轮任务\n' +
        '\n*同一群同一用户可开 N 个会话 slot；话题群里一个话题 = 一个独立会话*',
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
        '`/danger on|off`  当前会话切权限模式 · 加 `--global` 切全局\n' +
        '`/reload`  热重载配置\n' +
        '`/profile use <name>`  当前会话切 API 配置 · 加 `--global` 切全局默认\n' +
        '`/usage`  Token/Cost 看板  ·  `/ping`  健康检查\n' +
        '`/help --pin`  把本卡片置顶到群（当命令面板用）',
    ),
    hr(),

    md('*📺 卡片按钮直接触发 · 直接发消息=发到活跃会话 · 建议把本卡片 Pin 到群顶当命令面板*'),
  ]);
}
