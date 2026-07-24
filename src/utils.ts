/** JSON 值的预览截断（用于审批卡片、流式卡片等场景） */
export function previewJson(v: unknown, maxLen = 400): string {
  let s: string;
  if (typeof v === 'string') {
    s = v;
  } else {
    try {
      s = JSON.stringify(v, null, 2) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}
