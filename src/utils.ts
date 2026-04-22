/** JSON 值的预览截断（用于审批卡片、流式卡片等场景） */
export function previewJson(v: unknown, maxLen = 400): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}
