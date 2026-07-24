import type * as Lark from '@larksuiteoapi/node-sdk';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import { isAllowed } from '../auth.js';
import { translateSdkMessage } from '../engine/events.js';
import { log } from '../logger.js';
import { buildAgentEnv } from '../agent/env.js';

/**
 * 云文档划词评论集成（借鉴 lark-bridge bot/comments.ts）。
 *
 * 用户在飞书文档评论里 @bot → 拉取整条评论线程作为上下文 →
 * 跑一次性 agent → 把回答回复到同一评论线程。
 *
 * 前置条件：应用订阅 drive.notice.comment_add_v1 事件，
 * 且拥有 drive:drive（云文档评论读写）权限。
 */

interface CommentAddEvent {
  comment_id?: string;
  reply_id?: string;
  is_mentioned?: boolean;
  notice_meta?: {
    file_type?: string;
    file_token?: string;
    from_user_id?: { open_id?: string };
    notice_type?: string;
  };
}

type FileType = 'doc' | 'sheet' | 'file' | 'docx' | 'slides' | 'bitable';
const SUPPORTED_FILE_TYPES = new Set<string>(['doc', 'docx', 'sheet', 'file', 'slides', 'bitable']);
const REPLY_MAX = 2000;

export interface CommentHandlerDeps {
  client: Lark.Client;
  cfg: Config;
  /** API profile env 注入（可选功能） */
  apiProfiles?: { envOverrides(): Record<string, string> };
}

export function buildCommentHandler(deps: CommentHandlerDeps): (raw: unknown) => Promise<void> {
  // 同一评论线程一次只跑一个 agent
  const inFlight = new Set<string>();

  return async (raw) => {
    const evt = extractEvent(raw);
    const fileToken = evt.notice_meta?.file_token;
    const fileType = evt.notice_meta?.file_type;
    const fromOpenId = evt.notice_meta?.from_user_id?.open_id ?? '';

    // 只处理 @bot 的评论（也天然排除 bot 自己的回复）
    if (!evt.is_mentioned || !fileToken || !fileType || !evt.comment_id) return;
    if (!SUPPORTED_FILE_TYPES.has(fileType)) {
      log().debug({ fileType }, '评论所在文件类型不支持，忽略');
      return;
    }
    if (!isAllowed(deps.cfg, fromOpenId, '')) {
      log().warn({ fromOpenId, fileToken }, '评论提及：发起者未授权，忽略');
      return;
    }

    const scope = `${fileToken}:${evt.comment_id}`;
    if (inFlight.has(scope)) {
      log().info({ scope }, '该评论线程已有 agent 在跑，忽略重复触发');
      return;
    }
    if (inFlight.size >= deps.cfg.max_concurrent_comment_queries) {
      log().warn(
        { scope, limit: deps.cfg.max_concurrent_comment_queries },
        '评论 agent 全局并发已满，忽略本次触发',
      );
      return;
    }
    inFlight.add(scope);
    try {
      await handleMention(deps, {
        fileToken,
        fileType: fileType as FileType,
        commentId: evt.comment_id,
      });
    } catch (err) {
      log().error({ err, scope }, '评论提及处理失败');
    } finally {
      inFlight.delete(scope);
    }
  };
}

async function handleMention(
  deps: CommentHandlerDeps,
  ctx: { fileToken: string; fileType: FileType; commentId: string },
): Promise<void> {
  const { client, cfg } = deps;

  // 1. 拉评论线程（划词内容 + 全部回复）
  const resp = await client.drive.v1.fileComment.get({
    params: { file_type: ctx.fileType, user_id_type: 'open_id' },
    path: { file_token: ctx.fileToken, comment_id: ctx.commentId },
  });
  const comment = resp.data;
  if (!comment) return;

  const quote = comment.quote ?? '';
  const replies = (comment.reply_list?.replies ?? []).map((r) => ({
    user: r.user_id ?? '',
    text: (r.content?.elements ?? [])
      .map((e) => (e.type === 'text_run' ? e.text_run?.text ?? '' : e.type === 'docs_link' ? e.docs_link?.url ?? '' : ''))
      .join(''),
  }));
  const thread = replies.map((r, i) => `${i + 1}. [${r.user.slice(-6) || '?'}] ${r.text}`).join('\n');

  // 2. 一次性 agent（只读工具，文档场景不需要写文件）
  const prompt =
    `你收到一条飞书云文档评论提及。请直接给出简洁、可落地的回答（纯文本，不要 Markdown 标记，${REPLY_MAX} 字符以内）。\n\n` +
    `文档: ${ctx.fileType} ${ctx.fileToken}\n` +
    (quote ? `划词内容（用户评论针对的原文）:\n"""\n${quote}\n"""\n\n` : '') +
    `评论线程（最后一条是刚 @你 的）:\n${thread}`;

  const envOverrides = deps.apiProfiles?.envOverrides() ?? {};
  const options: Options = {
    cwd: cfg.default_cwd,
    // 评论回答所需上下文已完整放入 prompt，不需要访问本地文件或执行工具。
    // 禁用工具，避免文档评论中的提示注入借机触发远程副作用。
    allowedTools: [],
    persistSession: false,
    env: buildAgentEnv(cfg.agent_env_allowlist, envOverrides),
  };

  let answer = '';
  const abortController = new AbortController();
  const q = query({ prompt, options: { ...options, abortController } });
  const timeoutMs = cfg.claude_ask_timeout_min * 60_000;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      void q.interrupt().catch(() => {});
      reject(new Error(`COMMENT_TIMEOUT:${timeoutMs}`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const iterator = q[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), timeoutPromise]);
      if (next.done) break;
      const msg = next.value;
      for (const ev of translateSdkMessage(msg)) {
        if (ev.kind === 'assistant-text') answer += ev.text;
        if (ev.kind === 'result' && !answer.trim() && ev.text) answer = ev.text;
      }
    }
  } catch (err) {
    if (!timedOut) throw err;
    log().warn({ fileToken: ctx.fileToken, commentId: ctx.commentId, timeoutMs }, '评论 agent 超时，使用已有输出收尾');
  } finally {
    if (timer) clearTimeout(timer);
    q.close();
  }
  answer = answer.trim().slice(0, REPLY_MAX);
  if (!answer) {
    log().warn({ scope: `${ctx.fileToken}:${ctx.commentId}` }, '评论 agent 无输出，跳过回复');
    return;
  }

  // 3. 回复到同一评论线程；整篇评论（whole-doc）不接受 reply（错误码 1069302），
  //    降级为在文档上新建一条全局评论
  try {
    await client.drive.v1.fileCommentReply.create({
      params: { file_type: ctx.fileType, user_id_type: 'open_id' },
      path: { file_token: ctx.fileToken, comment_id: ctx.commentId },
      data: { content: { elements: [{ type: 'text_run', text_run: { text: answer } }] } },
    });
    log().info({ fileToken: ctx.fileToken, commentId: ctx.commentId }, '评论回复已发送');
  } catch (err) {
    if ((ctx.fileType === 'doc' || ctx.fileType === 'docx') && larkErrorCode(err) === 1069302) {
      log().warn({ err }, '评论 reply 失败，降级为新建全局评论');
      await client.drive.v1.fileComment.create({
        params: { file_type: ctx.fileType, user_id_type: 'open_id' },
        path: { file_token: ctx.fileToken },
        data: {
          reply_list: {
            replies: [{ content: { elements: [{ type: 'text_run', text_run: { text: answer } }] } }],
          },
        },
      });
    } else {
      throw err;
    }
  }
}

function larkErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const rec = err as Record<string, unknown>;
  const candidates = [
    rec['code'],
    (rec['response'] as Record<string, unknown> | undefined)?.['code'],
    ((rec['response'] as Record<string, unknown> | undefined)?.['data'] as Record<string, unknown> | undefined)?.['code'],
    (rec['data'] as Record<string, unknown> | undefined)?.['code'],
  ];
  for (const value of candidates) {
    const code = Number(value);
    if (Number.isInteger(code) && code > 0) return code;
  }
  return undefined;
}

function extractEvent(raw: unknown): CommentAddEvent {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  return (r['event'] as CommentAddEvent | undefined) ?? (r as CommentAddEvent);
}
