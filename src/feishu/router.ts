import type { CommandDeps, CommandFn } from '../commands/types.js';
import type { Replier } from './replier.js';
import { textCard } from './cards/base.js';

export interface MessageMeta {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  mentionBot: boolean;
}

interface RegisteredCommand {
  name: string;
  fn: CommandFn;
}

export class Router {
  private readonly cmds = new Map<string, RegisteredCommand>();
  private readonly ordered: RegisteredCommand[] = [];

  constructor(
    private readonly replier: Replier,
    private readonly deps: CommandDeps,
  ) {}

  register(name: string, fn: CommandFn, aliases: string[] = []): void {
    const entry: RegisteredCommand = { name, fn };
    this.cmds.set(name, entry);
    for (const a of aliases) this.cmds.set(a, entry);
    this.ordered.push(entry);
  }

  async dispatch(text: string, meta: MessageMeta): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      const rest = trimmed.slice(1);
      const spaceIdx = rest.indexOf(' ');
      const name = (spaceIdx < 0 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
      const args = spaceIdx < 0 ? '' : rest.slice(spaceIdx + 1);
      const cmd = this.cmds.get(name);
      if (!cmd) {
        await this.replyAsCard(meta.messageId, `未知命令: /${name}\n输入 /help 查看可用命令`);
        return;
      }
      const result = await cmd.fn(args, meta, this.deps);
      if (result) await this.replyAsCard(meta.messageId, result);
      return;
    }

    const sendCmd = this.cmds.get('s');
    if (sendCmd) {
      const result = await sendCmd.fn(trimmed, meta, this.deps);
      if (result) {
        if (result.includes('没有活跃的会话')) {
          const ask = this.cmds.get('ask');
          if (ask) {
            const r = await ask.fn(trimmed, meta, this.deps);
            if (r) await this.replyAsCard(meta.messageId, r);
            return;
          }
        }
        await this.replyAsCard(meta.messageId, result);
      }
    }
  }

  private async replyAsCard(messageId: string, text: string): Promise<void> {
    const ok = await this.replier.replyCard(messageId, textCard(text));
    if (!ok) {
      await this.replier.replyText(messageId, text);
    }
  }
}
