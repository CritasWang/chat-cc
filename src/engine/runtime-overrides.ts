import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from '../platform/atomic-write.js';
import { chatccHome } from '../paths.js';
import { log } from '../logger.js';

/**
 * 运行时配置覆盖 — 持久化到 ~/.chat-cc/runtime-overrides.json。
 *
 * 修复「/danger on --global 重启后失效」：飞书命令改的是内存里的 config
 * 对象，daemon 重启从 config.yaml 重读就回落了。现在全局级的运行时切换
 * 落盘，启动时叠加在文件配置之上。
 *
 * 注意：覆盖优先于 config.yaml —— /danger 状态里会标注来源；
 * 想回归纯文件配置，用 /danger off --global 显式设置即可。
 */

export interface RuntimeOverrides {
  claude_danger_mode?: boolean;
  /** /model <name> --global 写入；空串表示显式回归“不指定模型” */
  claude_model?: string;
}

function overridesPath(): string {
  return join(chatccHome(), 'runtime-overrides.json');
}

export function loadRuntimeOverrides(): RuntimeOverrides {
  const p = overridesPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const rec = raw as Record<string, unknown>;
    return {
      ...(typeof rec['claude_danger_mode'] === 'boolean'
        ? { claude_danger_mode: rec['claude_danger_mode'] }
        : {}),
      // 用 typeof 而非真值判断：'' 是合法值（显式回归“不指定模型”）
      ...(typeof rec['claude_model'] === 'string' ? { claude_model: rec['claude_model'] } : {}),
    };
  } catch (err) {
    log().warn({ err }, 'runtime-overrides 读取失败，忽略');
    return {};
  }
}

export function saveRuntimeOverride<K extends keyof RuntimeOverrides>(
  key: K,
  value: RuntimeOverrides[K],
): void {
  const current = loadRuntimeOverrides();
  current[key] = value;
  try {
    writeFileAtomicSync(overridesPath(), JSON.stringify(current, null, 2));
  } catch (err) {
    log().warn({ err }, 'runtime-overrides 持久化失败（本次运行内仍生效）');
  }
}
