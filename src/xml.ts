// Minimal XML parser (elements, attributes, text, entities), enough for MusicXML.
//
// Not a validating or namespace-aware parser: comments, processing instructions and the DOCTYPE are
// skipped, CDATA is kept as text, and mixed content is concatenated into the element's `text`.

import { must } from './util.ts';

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Resolves the predefined and numeric character entities in `s`; unknown entities stay as they are. */
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

/** The index after a DOCTYPE, which may contain an internal subset in [ ... ] with its own `>`s, so the bracket depth is tracked. MusicXML files carry a DOCTYPE with an external reference only, which we ignore. */
function endOfDoctype(src: string, lt: number): number {
  let depth = 0;
  let j = lt;
  for (; j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']') depth--;
    else if (src[j] === '>' && depth <= 0) break;
  }
  return j + 1;
}

/** The index of the `>` that ends the tag starting at `lt`. A `>` inside a quoted attribute value does not end it. */
function endOfTag(src: string, lt: number): number {
  let quote = '';
  let j = lt + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') break;
  }
  return j;
}

/** An element from the inside of its start tag (`name a="1" b='2'`, without `<`, `>` and a self-closing `/`). */
function parseStartTag(inner: string): XNode {
  const name = must(/^([^\s/]+)/.exec(inner));
  const node: XNode = { tag: name[1], attrs: {}, children: [], text: '' };
  const attribute = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const rest = inner.slice(name[0].length);
  for (let a = attribute.exec(rest); a; a = attribute.exec(rest)) node.attrs[a[1]] = unescapeXml(a[3] ?? a[4]);
  return node;
}

/** Parses an XML document into its root element. */
export function parseXml(src: string): XNode {
  let i = 0;
  const stack: XNode[] = [];
  let root: XNode | null = null;
  const appendText = (t: string) => {
    if (stack.length) stack[stack.length - 1].text += t;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) appendText(unescapeXml(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) i = src.indexOf('-->', lt) + 3;
    else if (src.startsWith('<?', lt)) i = src.indexOf('?>', lt) + 2;
    else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      appendText(src.slice(lt + 9, end));
      i = end + 3;
    } else if (src.startsWith('<!', lt)) i = endOfDoctype(src, lt);
    else {
      const end = endOfTag(src, lt);
      const body = src.slice(lt + 1, end);
      i = end + 1;
      if (body[0] === '/') {
        stack.pop();
        continue;
      }
      const selfClose = body.endsWith('/');
      const node = parseStartTag(selfClose ? body.slice(0, -1) : body);
      if (stack.length) stack[stack.length - 1].children.push(node);
      else root = node;
      if (!selfClose) stack.push(node);
    }
  }
  if (!root) throw new Error('empty XML');
  return root;
}

/** The first child element of `n` with the given tag. */
export function child(n: XNode | undefined, tag: string): XNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}

/** All child elements of `n` with the given tag. */
export function children(n: XNode | undefined, tag: string): XNode[] {
  return n ? n.children.filter((c) => c.tag === tag) : [];
}

/** The trimmed text of `n`, or of its child `tag` when one is given. */
export function text(n: XNode | undefined, tag?: string): string | undefined {
  const t = tag ? child(n, tag) : n;
  return t ? t.text.trim() : undefined;
}
