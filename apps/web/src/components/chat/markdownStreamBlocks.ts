// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(text)) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) break;
      if (
        opener &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      ) {
        fence = null;
      }
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
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
const ELEMENT_ID = /<h[1-6]|\bid\s*=/i;

// Heading ids are unique only within one rendered tree, so two headings in different blocks
// that could share an id rule out rendering the blocks apart.
export function headingIdsMayCollide(text: string): boolean {
  if (ELEMENT_ID.test(text)) return true;
  const seen = new Set<string>();
  let previousLine = "";
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
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
