#!/usr/bin/env node
import { runDaemon } from './daemon.js';
import { runInit } from './init.js';
import { runLogs } from './logs.js';
import { runConfigCmd } from './config-cmd.js';
import { runDoctor } from './doctor.js';
import { runVersion } from './version.js';

const HELP = `
chat-cc — 飞书 ↔ Claude Code 网关

用法:  chat-cc <command> [options]

Commands:
  init                  交互式初始化配置（~/.chat-cc/config.yaml）
  start [--foreground]  启动守护进程（默认后台）
  stop                  停止守护进程
  restart               重启守护进程
  status                查看进程状态
  logs [--follow] [-n]  查看/跟踪日志
  config <sub>          查看/修改配置（get|set|edit|path）
  doctor                环境检查
  version               版本信息

Options:
  -h, --help            帮助信息
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    return;
  }

  const rest = args.slice(1);

  switch (cmd) {
    case 'init':
      await runInit(rest);
      break;
    case 'start':
      await runDaemon('start', rest);
      break;
    case 'stop':
      await runDaemon('stop', rest);
      break;
    case 'restart':
      await runDaemon('restart', rest);
      break;
    case 'status':
      await runDaemon('status', rest);
      break;
    case 'logs':
    case 'log':
      await runLogs(rest);
      break;
    case 'config':
      await runConfigCmd(rest);
      break;
    case 'doctor':
    case 'doc':
      await runDoctor();
      break;
    case 'version':
    case '-v':
    case '--version':
      runVersion();
      break;
    default:
      console.error(`未知命令: ${cmd}\n运行 chat-cc --help 查看可用命令`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
