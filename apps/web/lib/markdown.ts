/**
 * A small, block-level markdown parser for `/docs/[slug]` — scoped to exactly the subset the
 * repository's own `docs/*.md` files use: headings (`#`/`##`/`###`), paragraphs, unordered and
 * ordered lists, fenced code blocks and pipe tables, with `**bold**`/`` `code` `` inline. Not a
 * general CommonMark implementation — anything outside that subset (nested lists, links,
 * blockquotes, italics) passes through as plain paragraph text rather than rendering wrong.
 */

export type MdNode =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; lang?: string; text: string }
  | { type: "table"; header: string[]; rows: string[][] };

const HEADING = /^(#{1,3})\s+(.*)$/;
const FENCE = /^```\s*(\S*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const BULLET_ITEM = /^[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\d+\.\s+(.*)$/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;
const BLOCK_START = /^(#{1,3}\s+|```|[-*]\s+|\d+\.\s+)/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

/** Parses `source` into a flat block list, top to bottom. Lists don't nest — a more-indented
 * line inside a list item is folded into that item's own text as a continuation, not a nested
 * list, matching every list in the repository's docs. */
export function parseMarkdown(source: string): MdNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: MdNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      nodes.push({ type: "heading", level: (level >= 1 && level <= 3 ? level : 3) as 1 | 2 | 3, text: (heading[2] ?? "").trim() });
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip the closing fence (or end of input if unterminated)
      nodes.push({ type: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    if (line.trim().startsWith("|") && TABLE_SEPARATOR.test((lines[i + 1] ?? "").trim())) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      nodes.push({ type: "table", header, rows });
      continue;
    }

    const bullet = BULLET_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (bullet || ordered) {
      const isOrdered = ordered !== null;
      const itemPattern = isOrdered ? ORDERED_ITEM : BULLET_ITEM;
      const items: string[] = [(bullet ?? ordered)?.[1]?.trim() ?? ""];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        const itemMatch = itemPattern.exec(next);
        if (itemMatch) {
          items.push((itemMatch[1] ?? "").trim());
          i++;
          continue;
        }
        if (next.trim() !== "" && /^\s{2,}\S/.test(next)) {
          items[items.length - 1] = `${items[items.length - 1] ?? ""} ${next.trim()}`.trim();
          i++;
          continue;
        }
        break;
      }
      nodes.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    const paraLines: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || BLOCK_START.test(next) || next.trim().startsWith("|")) break;
      paraLines.push(next.trim());
      i++;
    }
    nodes.push({ type: "paragraph", text: paraLines.join(" ") });
  }

  return nodes;
}

/** Splits a parsed document's leading level-1 heading (its own title line) from the rest, so a
 * page can render that heading once, as a real page `<h1>`, instead of duplicating it as both
 * the page chrome's title and the first rendered block. `title` is `undefined` when the
 * document doesn't open with one — `body` is then every node, unchanged. */
export function splitLeadingHeading(nodes: readonly MdNode[]): { title?: string; body: MdNode[] } {
  const [first, ...rest] = nodes;
  if (first?.type === "heading" && first.level === 1) return { title: first.text, body: rest };
  return { title: undefined, body: [...nodes] };
}

export type MdInline = { kind: "text"; text: string } | { kind: "bold"; text: string } | { kind: "code"; text: string };

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`/g;

/** Splits one line of text into plain/bold/code runs, in order. */
export function parseInline(text: string): MdInline[] {
  const tokens: MdInline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    if (index > last) tokens.push({ kind: "text", text: text.slice(last, index) });
    if (match[1] !== undefined) tokens.push({ kind: "bold", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "code", text: match[2] });
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}
