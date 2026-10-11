import type { Variant } from './model.ts';
export function articlePackageHtml(variant: Variant): string {
  const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
  const paragraphs = variant.text.split(/\n{2,}/).map(value => `<p>${escape(value).replace(/\n/g, '<br>')}</p>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(variant.title)}</title><body><article><h1>${escape(variant.title)}</h1>${paragraphs}</article></body></html>`;
}
