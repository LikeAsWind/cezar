import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const omittedElements = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math']);
const transparentElements = new Set(['html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'span']);

function children(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : [];
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find(value => value.name.toLowerCase() === name)?.value;
}

function escapeTableCell(text: string): string {
  let output = '';
  let slashes = 0;
  for (const character of text) {
    if (character === '\\') {
      slashes += 1;
      output += character;
      continue;
    }
    if (character === '|') output += '\\'.repeat(slashes + 1);
    output += character;
    slashes = 0;
  }
  return output;
}

function safeLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.href.replace(/[()\s]/g, value => encodeURIComponent(value));
  } catch {
    return undefined;
  }
}

/** Convert untrusted TAPD rich text into plain Markdown without fetching linked content. */
export function tapdHtmlMarkdown(html: string): { body: string; unsupportedContent: boolean } {
  const fragment = parseFragment(html);
  let unsupportedContent = false;
  let visited = 0;

  const render = (node: Node, depth = 0): string => {
    if (++visited > 50_000 || depth > 50) {
      unsupportedContent = true;
      return '';
    }
    if ('value' in node) return node.value.replace(/\s+/g, ' ');
    if (node.nodeName === '#comment' || node.nodeName === '#documentType') return '';
    if (!('tagName' in node)) return children(node).map(child => render(child, depth + 1)).join('');

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (omittedElements.has(tag)) {
      unsupportedContent = true;
      return '';
    }
    const content = () => children(element).map(child => render(child, depth + 1)).join('');
    if (transparentElements.has(tag)) return content();
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${content().trim()}\n\n`;
    if (tag === 'p') return `${content().trim()}\n\n`;
    if (tag === 'br') return '  \n';
    if (tag === 'strong' || tag === 'b') return `**${content()}**`;
    if (tag === 'em' || tag === 'i') return `*${content()}*`;
    if (tag === 'del' || tag === 's' || tag === 'strike') return `~~${content()}~~`;
    if (tag === 'blockquote') return `${content().trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    if (tag === 'hr') return '---\n\n';
    if (tag === 'a') {
      const text = content();
      const href = safeLink(attribute(element, 'href'));
      if (!href) {
        unsupportedContent = true;
        return text;
      }
      return `[${text}](${href})`;
    }
    if (tag === 'img' || tag === 'video' || tag === 'audio' || tag === 'canvas') {
      unsupportedContent = true;
      return content();
    }
    if (tag === 'pre') {
      const raw = children(element).map(child => {
        if ('tagName' in child && child.tagName.toLowerCase() === 'code') return children(child).map(grandchild => render(grandchild, depth + 2)).join('');
        return render(child, depth + 1);
      }).join('').trimEnd();
      const code = children(element).find((child): child is Element => 'tagName' in child && child.tagName.toLowerCase() === 'code');
      const language = attribute(code ?? element, 'class')?.match(/(?:^|\s)language-([a-zA-Z0-9_+-]+)/)?.[1] ?? '';
      const longest = Math.max(0, ...[...raw.matchAll(/`+/g)].map(match => match[0].length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `${fence}${language}\n${raw}\n${fence}\n\n`;
    }
    if (tag === 'code') return `\`${content()}\``;
    if (tag === 'ul' || tag === 'ol') {
      const start = tag === 'ol' ? Number(attribute(element, 'start')) || 1 : 1;
      const items = children(element).filter((child): child is Element => 'tagName' in child && child.tagName.toLowerCase() === 'li');
      return `${items.map((item, index) => `${tag === 'ul' ? '- ' : `${start + index}. `}${render(item, depth + 1).trim().replace(/\n/g, '\n  ')}`).join('\n')}\n\n`;
    }
    if (tag === 'li') return content();
    if (tag === 'table') {
      const rows: string[][] = [];
      const collect = (candidate: Node): void => {
        if ('tagName' in candidate && candidate.tagName.toLowerCase() === 'tr') {
          rows.push(children(candidate)
            .filter((cell): cell is Element => 'tagName' in cell && ['th', 'td'].includes(cell.tagName.toLowerCase()))
            .map(cell => escapeTableCell(children(cell).map(child => render(child, depth + 2)).join('').trim()).replace(/\n/g, '<br>')));
          return;
        }
        for (const child of children(candidate)) collect(child);
      };
      collect(element);
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const lines = rows.map(row => `| ${[...row, ...Array<string>(width - row.length).fill('')].join(' | ')} |`);
      lines.splice(1, 0, `| ${Array<string>(width).fill('---').join(' | ')} |`);
      return `${lines.join('\n')}\n\n`;
    }
    if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'tr' || tag === 'th' || tag === 'td') return content();

    unsupportedContent = true;
    return content();
  };

  const body = children(fragment).map(node => render(node)).join('')
    .replace(/\n +/g, '\n')
    .replace(/ +\n\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { body, unsupportedContent };
}
