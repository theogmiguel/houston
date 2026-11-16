// Block HTML, container directives and display math at a line start, footnotes and definitions,
// checked on the remainder when fence tracking is lost.
const DOCUMENT_WIDE_SYNTAX = /\]:|\[\^|^ {0,3}(?:<[A-Za-z!?/]|:::|\$\$)/m;
const BLOCK_SYNTAX = /^ {0,3}(?:<[A-Za-z!?/]|:::|\$\$)/;
// A definition or footnote definition opens a line, after any quote or list markers, with "[".
const LABEL_START = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*\[/;
// Parsed raw HTML left open in one paragraph continues into the next.
const INLINE_HTML = /<[A-Za-z!?/]/;
const URL_AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/g;
// Before a span opener, these may belong to math, a link destination or an escape.
const SPAN_UNSAFE = /\$|\]\(/;
const OPENER_UNSAFE = /[\w\\/.]$/;
// An autolink or a bare URL may run through a backtick, which then opens no span.
const URL_TOKEN = /(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:|www\.)[^\s<>]*$/;
// A line of only pipes, dashes, colons and container markers may be a table's delimiter row.
const DELIMITER_ROW = /^[\s>*+\d.):|-]*$/;
const BACKTICK_RUN = /`+/g;
// A backtick fence's info string has no backtick.
const FENCE_PATTERN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_RUN_LINE = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/;
const SHALLOW_INDENT = /^ {0,3}$/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
const NON_SPACE = /\S/;

const hasHtml = (text: string) => INLINE_HTML.test(text.replace(URL_AUTOLINK, ""));

// Whether a line closes an open fence; null when only an untracked list item could tell: a run
// indented by a tab or past three spaces closes it inside an item, not at the top level.
function closesFence(line: string, fence: string): boolean | null {
  const run = FENCE_RUN_LINE.exec(line);
  if (!run || run[2]![0] !== fence[0] || run[2]!.length < fence.length) return false;
  return SHALLOW_INDENT.test(run[1]!) ? true : null;
}

const isDelimiterRow = (line: string) =>
  line.includes("|") && line.includes("-") && DELIMITER_ROW.test(line);

// Reports raw HTML outside code spans that pair within one line, and whether a backtick run is
// left open: one left open on an earlier line of the paragraph may pair with a run on this one.
function htmlOutsideCode(line: string, open: boolean): { html: boolean; open: boolean } {
  const html = hasHtml(line);
  if (open) return { html, open: true };
  const runs = [...line.matchAll(BACKTICK_RUN)];
  let outside = "";
  let index = 0;
  for (let i = 0; i < runs.length; i++) {
    const opener = runs[i]!;
    if (opener.index! < index) continue;
    outside += line.slice(index, opener.index);
    const closer = runs.slice(i + 1).find((run) => run[0].length === opener[0].length);
    if (
      !closer ||
      SPAN_UNSAFE.test(outside) ||
      OPENER_UNSAFE.test(outside) ||
      URL_TOKEN.test(line.slice(index, opener.index))
    ) {
      return { html, open: true };
    }
    index = closer.index! + closer[0].length;
  }
  return { html: hasHtml(outside + line.slice(index)), open: false };
}

// Cuts Markdown at blank lines that close every open block, so each piece renders as it would in
// the whole text. Null when the text uses syntax that spans blocks, which with `rawHtml` includes
// HTML outside code fences and code spans.
export function splitMarkdownBlocks(text: string, rawHtml = true): string[] | null {
  if (text.includes("\r")) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  let labelOpen = false;
  let spanOpen = false;
  let table = false;
  let paragraph: string[] = [];
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (NON_SPACE.test(line.slice(0, fenceIndent))) {
        const rest = text.slice(lineStart);
        if (DOCUMENT_WIDE_SYNTAX.test(rest) || (rawHtml && INLINE_HTML.test(rest))) return null;
        break;
      }
      const closes = closesFence(line, fence);
      if (closes === null) return null;
      if (closes) fence = null;
    } else if (line.trim() === "") {
      afterBlankLine = true;
      labelOpen = false;
      spanOpen = false;
      table = false;
      paragraph = [];
    } else {
      if (BLOCK_SYNTAX.test(line)) return null;
      if (opener) {
        labelOpen = false;
        spanOpen = false;
        table = false;
        paragraph = [];
      } else {
        const label = LABEL_START.exec(line);
        if (label) labelOpen = true;
        if (labelOpen && line.slice(label ? label[0].length : 0).includes("]:")) return null;
        if (rawHtml) {
          // A table cuts cells at every pipe before it pairs code spans, so in a paragraph with a
          // delimiter row, piped lines (the header too) count HTML inside code spans as well.
          if (!table && isDelimiterRow(line)) {
            table = true;
            if (paragraph.some((row) => row.includes("|") && hasHtml(row))) return null;
          }
          if (table && line.includes("|")) {
            if (hasHtml(line)) return null;
          } else {
            const scan = htmlOutsideCode(line, spanOpen);
            if (scan.html) return null;
            spanOpen = scan.open;
          }
        }
        paragraph.push(line);
      }
      if (afterBlankLine && lineStart > blockStart && !CONTINUATION_PATTERN.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const ATX_HEADING = /^(?:[ \t>]|[-*+][ \t]|\d{1,9}[.)][ \t])*#{1,6}(?:[ \t]+(.*))?$/;
// Heading text whose rendered words can differ from its source: links, entities, escapes, HTML, math.
const REWRITTEN_HEADING_TEXT = /[[\]&<\\$]/;
const HEADING_KEY_DROP = /[^\p{L}\p{M}\p{N}]/gu;

// Heading ids are unique only within one rendered tree, so two headings in different blocks
// that could share an id rule out rendering the blocks apart. An element id needs raw HTML
// outside code, which splitMarkdownBlocks already refuses.
export function headingIdsMayCollide(text: string): boolean {
  const seen = new Set<string>();
  let previousLine = "";
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      const closes = closesFence(line, fence);
      if (closes === null) return true;
      if (closes) fence = null;
      continue;
    }
    if (opener) {
      fence = opener;
      continue;
    }
    if (previousLine.trim() !== "" && SETEXT_UNDERLINE.test(line)) return true;
    previousLine = line;
    const heading = ATX_HEADING.exec(line);
    if (!heading) continue;
    const content = heading[1] ?? "";
    if (REWRITTEN_HEADING_TEXT.test(content)) return true;
    const key = content.toLowerCase().replace(HEADING_KEY_DROP, "");
    if (key === "") continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
