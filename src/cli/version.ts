import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runVersion(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(__dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string; dependencies?: Record<string, string> };
    const sdkVer = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? 'unknown';
    console.log(`chat-cc v${pkg.version ?? 'unknown'}`);
    console.log(`node ${process.version}`);
    console.log(`claude-agent-sdk ${sdkVer}`);
  } catch {
    console.log('chat-cc (版本信息不可用)');
    console.log(`node ${process.version}`);
  }
}
