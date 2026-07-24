import { describe, it, expect } from 'vitest';
import { extractAgentFlag } from '../../src/commands/session.js';

describe('extractAgentFlag 引擎标记解析', () => {
  it('无标记原样返回', () => {
    expect(extractAgentFlag('@myapp')).toEqual({ rest: '@myapp' });
    expect(extractAgentFlag('')).toEqual({ rest: '' });
  });

  it('--codex / --claude 摘出并清理参数', () => {
    expect(extractAgentFlag('@myapp --codex')).toEqual({ rest: '@myapp', agent: 'codex' });
    expect(extractAgentFlag('--claude /path/to/proj')).toEqual({ rest: '/path/to/proj', agent: 'claude' });
    expect(extractAgentFlag('--codex')).toEqual({ rest: '', agent: 'codex' });
  });

  it('标记在中间也能摘出', () => {
    expect(extractAgentFlag('chat 我的项目 --codex 群')).toEqual({ rest: 'chat 我的项目  群', agent: 'codex' });
  });

  it('不误伤相似词（--codexx / precodex）', () => {
    expect(extractAgentFlag('build --codexx')).toEqual({ rest: 'build --codexx' });
    expect(extractAgentFlag('pre--codex')).toEqual({ rest: 'pre--codex' });
  });
});
