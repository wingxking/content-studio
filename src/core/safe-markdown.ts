import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import type { Element, Root } from 'hast';

function restrictArticleResources() {
  return (tree: Root): void => {
    const visit = (parent: Root | Element): void => {
      for (const [index, node] of parent.children.entries()) {
        if (node.type !== 'element') continue;
        // Only separately validated, managed assets may be uploaded by a draft adapter.
        if (node.tagName === 'img') {
          parent.children[index] = { type: 'text', value: String(node.properties.alt ?? '') };
          continue;
        }
        if (node.tagName === 'a') {
          try {
            const url = new URL(String(node.properties.href ?? ''));
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) delete node.properties.href;
          } catch { delete node.properties.href; }
        }
        visit(node);
      }
    };
    visit(tree);
  };
}

const renderer = unified().use(remarkParse).use(remarkGfm)
  // Raw HTML is deliberately not passed through to the HTML tree.
  .use(remarkRehype).use(restrictArticleResources).use(rehypeSanitize).use(rehypeStringify);

export function safeMarkdownToHtml(markdown: string): string {
  return String(renderer.processSync(markdown));
}
