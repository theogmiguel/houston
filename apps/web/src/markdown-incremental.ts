import type { Root, RootContent } from "mdast";
import type { Parser as UnifiedParser, Plugin } from "unified";

type Parser = UnifiedParser<Root>;

interface ParsedPrefix {
  source: string;
  offset: number;
  line: number;
  children: RootContent[];
}

function hasDefinitions(node: Root | RootContent): boolean {
  return (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    ("children" in node && node.children.some((child) => hasDefinitions(child)))
  );
}

function shiftPositions(node: Root | RootContent, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if ("children" in node) {
    for (const child of node.children) shiftPositions(child, offset, lines);
  }
}

// Parser output is plain data, so a recursive copy suffices and skips structuredClone's
// serialisation on every streamed render.
function cloneParsed<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneParsed) as T;
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) copy[key] = cloneParsed(field);
  return copy as T;
}

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/;
const BLANK_LINE_SEPARATOR = /^\n[ \t]*\n/;
const TRAILING_WHITESPACE = /^[ \t]*$/;

// Same test as /^ {0,3}F{n,}[ \t]*$/ for an opening fence of n characters F.
function closesFence(line: string, opening: string): boolean {
  let start = 0;
  while (start < 3 && line[start] === " ") start++;
  let end = start;
  while (line[end] === opening[0]) end++;
  return end - start >= opening.length && TRAILING_WHITESPACE.test(line.slice(end));
}

// Cache completed fences followed by blank lines; document-wide definitions require a full parse.
function createIncrementalMarkdownParser(parse: Parser): Parser {
  let cached: ParsedPrefix | undefined;

  return (source, file) => {
    // Streaming CR may become CRLF; parsing a suffix separately would strip an internal BOM.
    if (source.includes("\r") || source.includes("\uFEFF")) return parse(source, file);

    const prefix = cached && source.startsWith(cached.source) ? cached : undefined;
    let root: Root;
    if (prefix) {
      root = parse(source.slice(prefix.offset), file);
      if (hasDefinitions(root)) return parse(source, file);
      shiftPositions(root, prefix.offset, prefix.line - 1);
      if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
      // Remark mutates nodes; give each render a clone of the pristine cache.
      root.children.unshift(...cloneParsed(prefix.children));
    } else {
      root = parse(source, file);
      if (hasDefinitions(root)) return root;
    }

    for (let index = root.children.length - 1; index >= 0; index--) {
      const node = root.children[index];
      if (node?.type !== "code") continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (prefix && end < prefix.offset) break;
      const value = source.slice(start, end);
      const opening = FENCE_OPENING.exec(value)?.[1];
      if (!opening) continue;
      const lastLine = value.slice(value.lastIndexOf("\n") + 1);
      const separator = BLANK_LINE_SEPARATOR.exec(source.slice(end))?.[0];
      if (!closesFence(lastLine, opening) || !separator) continue;
      const offset = end + separator.length;
      cached = {
        source: source.slice(0, offset),
        offset,
        line: node.position!.end.line + 2,
        children: cloneParsed(root.children.slice(0, index + 1)),
      };
      break;
    }
    return root;
  };
}

/** Use one cache per streaming renderer; extra syntax plugins require the normal parser. */
export function createIncrementalMarkdownPlugin(): Plugin<[], Root> {
  let parser: Parser | undefined;
  return function () {
    const original = this.parser;
    if (!original) return;
    parser ??= createIncrementalMarkdownParser((source, file) => original(source, file) as Root);
    const parseDocument = parser;
    // ReactMarkdown parses recovery text second; only the first parse may access the document cache.
    let documentParsed = false;
    this.parser = (source, file) => {
      if (documentParsed) return original(source, file);
      documentParsed = true;
      return parseDocument(source, file);
    };
  };
}
