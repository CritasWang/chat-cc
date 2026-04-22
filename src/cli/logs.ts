import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { logPath } from '../paths.js';

export async function runLogs(args: string[]): Promise<void> {
  const lp = logPath();
  if (!existsSync(lp)) {
    console.log(`日志文件不存在: ${lp}\nchat-cc 可能还未启动过`);
    return;
  }

  const follow = args.includes('--follow') || args.includes('-f');
  const nIdx = args.findIndex((a) => a === '-n');
  const lines = nIdx >= 0 && args[nIdx + 1] ? Number(args[nIdx + 1]) : 50;

  if (follow) {
    const tail = spawn('tail', ['-f', '-n', String(lines), lp], { stdio: 'inherit' });
    await new Promise<void>((resolve) => {
      tail.on('close', () => resolve());
      process.on('SIGINT', () => { tail.kill(); resolve(); });
    });
    return;
  }

  const allLines: string[] = [];
  const rl = createInterface({ input: createReadStream(lp), crlfDelay: Infinity });
  for await (const line of rl) {
    allLines.push(line);
    if (allLines.length > lines) allLines.shift();
  }
  console.log(allLines.join('\n'));
}
