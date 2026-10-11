import { unified } from 'unified';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, PhrasingContent } from 'mdast';
import { z } from 'zod';

export type ArticleNode = { type: string; text?: string; attrs?: Record<string, string | number | boolean | null>; marks?: { type: string; attrs?: Record<string, string | number | boolean | null> }[]; content?: ArticleNode[] };
const attribute = z.union([z.string().max(12000), z.number().finite(), z.boolean(), z.null()]);
export const articleNodeSchema: z.ZodType<ArticleNode> = z.lazy(() => z.object({ type: z.enum(['doc', 'paragraph', 'heading', 'text', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'hardBreak', 'horizontalRule', 'image', 'citation']), text: z.string().max(80000).optional(), attrs: z.record(z.string(), attribute).optional(), marks: z.array(z.object({ type: z.enum(['bold', 'italic', 'strike', 'code', 'link']), attrs: z.record(z.string(), attribute).optional() })).max(8).optional(), content: z.array(articleNodeSchema).max(1000).optional() }));
export const articleDocumentSchema = z.object({ schemaVersion: z.literal(1), content: articleNodeSchema }).superRefine((value, context) => {
  let nodes = 0;
  const visit = (node: ArticleNode, depth: number): void => {
    if (++nodes > 10000 || depth > 30) { context.addIssue({ code: 'custom', message: 'Article document is too complex.' }); return; }
    if (node.type === 'doc' && depth > 0) context.addIssue({ code: 'custom', message: 'Nested document is invalid.' });
    if (node.type === 'text' && node.text === undefined) context.addIssue({ code: 'custom', message: 'Text nodes require text.' });
    if (node.type === 'heading' && ![1, 2, 3, 4, 5, 6].includes(Number(node.attrs?.level))) context.addIssue({ code: 'custom', message: 'Heading level is invalid.' });
    if (node.type === 'image' && !z.uuid().safeParse(node.attrs?.assetId).success) context.addIssue({ code: 'custom', message: 'Images require a stable asset ID.' });
    if (node.type === 'citation' && !z.string().regex(/^source-[0-9]{1,2}$/).safeParse(node.attrs?.citationId).success) context.addIssue({ code: 'custom', message: 'Citations require a stable citation ID.' });
    for (const mark of node.marks ?? []) if (mark.type === 'link' && !safeUrl(String(mark.attrs?.href ?? ''))) context.addIssue({ code: 'custom', message: 'Links must use HTTP(S).' });
    for (const child of node.content ?? []) visit(child, depth + 1);
  };
  if (value.content.type !== 'doc') context.addIssue({ code: 'custom', message: 'Article root must be a document.' });
  visit(value.content, 0);
});
export type ArticleDocument = z.infer<typeof articleDocumentSchema>;
const safeUrl = (value: string): boolean => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
export function documentFromText(text: string): ArticleDocument {
  return { schemaVersion: 1, content: { type: 'doc', content: text.split(/\n\s*\n/u).map(paragraph => ({ type: 'paragraph', content: paragraph ? [{ type: 'text', text: paragraph }] : [] })) } };
}
export function articleText(document: ArticleDocument): string {
  const nodeText = (node: ArticleNode): string => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'image') return `[Image: ${String(node.attrs?.alt ?? node.attrs?.assetId ?? '')}]`;
    if (node.type === 'citation') return `[${String(node.attrs?.citationId ?? '')}]`;
    const children = node.content ?? [];
    return children.map(nodeText).join(['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(node.type) ? '\n\n' : '');
  };
  return nodeText(articleDocumentSchema.parse(document).content).trim();
}
function markdownInline(node: ArticleNode): PhrasingContent[] {
  if (node.type === 'hardBreak') return [{ type: 'break' }];
  if (node.type === 'citation') return [{ type: 'text', value: `[${String(node.attrs?.citationId)}]` }];
  if (node.type === 'image') return [{ type: 'image', url: `asset:${String(node.attrs?.assetId)}`, alt: String(node.attrs?.alt ?? '') }];
  if (node.type !== 'text') return (node.content ?? []).flatMap(markdownInline);
  let result: PhrasingContent = { type: 'text', value: node.text ?? '' };
  for (const mark of node.marks ?? []) {
    if (mark.type === 'code') result = { type: 'inlineCode', value: node.text ?? '' };
    else if (mark.type === 'bold') result = { type: 'strong', children: [result] };
    else if (mark.type === 'italic') result = { type: 'emphasis', children: [result] };
    else if (mark.type === 'strike') result = { type: 'delete', children: [result] };
    else if (mark.type === 'link') result = { type: 'link', url: String(mark.attrs?.href), children: [result] };
  }
  return [result];
}
function markdownBlock(node: ArticleNode): RootContent[] {
  if (node.type === 'doc' || node.type === 'listItem') return (node.content ?? []).flatMap(markdownBlock);
  if (node.type === 'heading') return [{ type: 'heading', depth: Number(node.attrs?.level) as 1 | 2 | 3 | 4 | 5 | 6, children: (node.content ?? []).flatMap(markdownInline) }];
  if (node.type === 'codeBlock') return [{ type: 'code', value: (node.content ?? []).map(child => child.text ?? '').join('') }];
  if (node.type === 'horizontalRule') return [{ type: 'thematicBreak' }];
  if (node.type === 'blockquote') return [{ type: 'blockquote', children: (node.content ?? []).flatMap(markdownBlock) as Extract<RootContent, { type: 'blockquote' }>['children'] }];
  if (node.type === 'bulletList' || node.type === 'orderedList') return [{ type: 'list', ordered: node.type === 'orderedList', start: node.type === 'orderedList' ? Number(node.attrs?.start ?? 1) : undefined, children: (node.content ?? []).map(child => ({ type: 'listItem', children: markdownBlock(child) as Extract<RootContent, { type: 'listItem' }>['children'] })) }];
  return [{ type: 'paragraph', children: markdownInline(node) }];
}
export function articleMarkdown(document: ArticleDocument): string {
  const content = articleDocumentSchema.parse(document).content;
  const root: Root = { type: 'root', children: markdownBlock(content) };
  return unified().use(remarkGfm).use(remarkStringify, { bullet: '-', fences: true }).stringify(root).trim();
}
export function articleHtml(document: ArticleDocument): string {
  const escape = (text: string): string => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
  const render = (node: ArticleNode): string => {
    if (node.type === 'text') return (node.marks ?? []).reduce((text, mark) => mark.type === 'link' ? `<a href="${escape(String(mark.attrs?.href))}" rel="noreferrer">${text}</a>` : `<${({ bold: 'strong', italic: 'em', strike: 's', code: 'code' } as Record<string, string>)[mark.type] ?? 'span'}>${text}</${({ bold: 'strong', italic: 'em', strike: 's', code: 'code' } as Record<string, string>)[mark.type] ?? 'span'}>`, escape(node.text ?? ''));
    if (node.type === 'hardBreak') return '<br>';
    if (node.type === 'horizontalRule') return '<hr>';
    if (node.type === 'citation') return `<span data-citation-id="${escape(String(node.attrs?.citationId))}">[${escape(String(node.attrs?.citationId))}]</span>`;
    if (node.type === 'image') return `<img src="/api/assets/${escape(String(node.attrs?.assetId))}/file" alt="${escape(String(node.attrs?.alt ?? ''))}">`;
    const children = (node.content ?? []).map(render).join(''); if (node.type === 'doc') return children;
    const tag = node.type === 'heading' ? `h${Number(node.attrs?.level)}` : ({ paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li', blockquote: 'blockquote', codeBlock: 'pre' } as Record<string, string>)[node.type] ?? 'div';
    return `<${tag}>${children}</${tag}>`;
  };
  return render(articleDocumentSchema.parse(document).content);
}
export function canonicalArticle<T extends { body: string; document?: ArticleDocument }>(value: T): T {
  if (!value.document) return value;
  const document = articleDocumentSchema.parse(value.document);
  return { ...value, document, body: articleText(document) };
}
