import type { CommandFn } from './types.js';

export const helpCommand: CommandFn = async () =>
  [
    'chatcc v3 命令：',
    '  /ping                     健康检查',
    '  /status                   系统状态',
    '  /ask [@别名] <问题>        无状态单次提问',
    '  /session start [@别名]    启动会话（长驻 Claude Agent）',
    '  /session stop [threadKey] 停止会话',
    '  /session list             列出会话',
    '  /s <消息>                  向活跃会话发送（或直接发文本）',
    '  /stop                     精确中断当前活跃会话',
    '  /usage                    累计 token/cost 看板',
    '  /help                     本帮助',
  ].join('\n');
