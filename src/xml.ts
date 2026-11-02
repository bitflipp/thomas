import { must } from './util.ts';
// Minimal XML parser (elements, attributes, text, entities), enough for MusicXML.
//
// Not a validating or namespace-aware parser: comments, processing instructions and the DOCTYPE are
// skipped, CDATA is kept as text, and mixed content is concatenated into the element's `text`.
export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

export function parseXml(src: string): XNode {
  let i = 0;
  const stack: XNode[] = [];
  let root: XNode | null = null;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i && stack.length) stack[stack.length - 1].text += unescapeXml(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      i = src.indexOf('-->', lt) + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      i = src.indexOf('?>', lt) + 2;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      if (stack.length) stack[stack.length - 1].text += src.slice(lt + 9, e);
      i = e + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE: may contain an internal subset in [ ... ] with its own `>`s, so track the bracket
      // depth. MusicXML files carry a DOCTYPE with an external reference only, which we ignore.
      let depth = 0;
      let j = lt;
      for (; j < n; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        else if (src[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    // Find the end of the tag. A `>` inside a quoted attribute value does not end it, so the
    // scan remembers the quote character it is in (`q`).
    let j = lt + 1;
    let q = '';
    for (; j < n; j++) {
      const c = src[j];
      if (q) {
        if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === '/') {
      stack.pop();
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = must(/^([^\s/]+)/.exec(inner));
    const node: XNode = { tag: m[1], attrs: {}, children: [], text: '' };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    const rest = inner.slice(m[0].length);
    for (let a = re.exec(rest); a; a = re.exec(rest)) node.attrs[a[1]] = unescapeXml(a[3] ?? a[4]);
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    if (!selfClose) stack.push(node);
  }
  if (!root) throw new Error('empty XML');
  return root;
}

export function child(n: XNode | undefined, tag: string): XNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}
export function children(n: XNode | undefined, tag: string): XNode[] {
  return n ? n.children.filter((c) => c.tag === tag) : [];
}
export function text(n: XNode | undefined, tag?: string): string | undefined {
  const t = tag ? child(n, tag) : n;
  return t ? t.text.trim() : undefined;
}
