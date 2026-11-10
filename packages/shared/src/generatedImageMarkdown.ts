import remarkParse from "remark-parse";
import { unified } from "unified";

import { markdownDestinationHostPath } from "./markdownLinks.ts";
import { chatMarkdownImageSources } from "./markdownPipeline.ts";
import { isUncPath, isWindowsDrivePath, normalizeProjectPathForComparison } from "./path.ts";

const ESCAPED_PATTERN = /[%?#&\\\r\n]/g;
const ESCAPED_PATTERN_2 = /[<>]/g;
const TAG_PATTERN = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;
const UNCLOSED_BLOCK_END_PATTERN = /<\/(?:script|pre|style|textarea)>/i;
const UNCLOSED_BLOCK_END_PATTERN_2 = /^ {0,3}<!--/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const ANY_LINE_BREAK = /\r\n|\r|\n/;
const CLOSING_PATTERN = /^ {0,3}(`{3,}|~{3,})[\t ]*$/;
const RESULT_PATTERN = /[\r\n]$/;

const parser = unified().use(remarkParse);

function imageEmbed(path: string): string {
  // Forward slashes read the same in every client parser; UNC paths also need file: to
  // distinguish them from protocol-relative web URLs.
  const destination = isWindowsDrivePath(path)
    ? path.replaceAll("\\", "/")
    : isUncPath(path)
      ? `file:${path.replaceAll("\\", "/")}`
      : path;
  // Clients split `?`/`#`, decode `%` and `&` entities, and read POSIX backslashes as escapes;
  // line breaks end an angle destination.
  const escaped = destination
    .replace(ESCAPED_PATTERN, encodeURIComponent)
    .replace(ESCAPED_PATTERN_2, "\\$&");
  return `![](<${escaped}>)`;
}

// An unclosed fence or raw HTML block swallows the rest of the reply. Only a root-level block
// can swallow appended embeds; nested ones end with their container.
function unclosedBlockEnd(text: string): string | undefined {
  const last = parser.parse(text).children.at(-1);
  const source = text.slice(last?.position?.start.offset, last?.position?.end.offset);
  if (last?.type === "html") {
    const tag = TAG_PATTERN.exec(source)?.[1];
    if (tag !== undefined) {
      return UNCLOSED_BLOCK_END_PATTERN.test(source) ? undefined : `</${tag}>`;
    }
    return UNCLOSED_BLOCK_END_PATTERN_2.test(source) && !source.includes("-->") ? "-->" : undefined;
  }
  if (last?.type !== "code") return undefined;
  const fence = FENCE_PATTERN.exec(source)?.[1];
  if (fence === undefined) return undefined;
  const lines = source.split(ANY_LINE_BREAK);
  const closing = CLOSING_PATTERN.exec(lines.at(-1) ?? "")?.[1];
  const closed =
    lines.length > 1 &&
    closing !== undefined &&
    closing[0] === fence[0] &&
    closing.length >= fence.length;
  return closed ? undefined : fence;
}

/** Appends an embed for each saved image the reply does not already show. */
export function appendGeneratedImageEmbeds(text: string, savedPaths: Iterable<string>): string {
  const shown = new Set(
    chatMarkdownImageSources(text).flatMap((source) => {
      const path = markdownDestinationHostPath(source);
      return path === null ? [] : [normalizeProjectPathForComparison(path)];
    }),
  );
  const missing = new Map<string, string>();
  for (const path of savedPaths) {
    const key = normalizeProjectPathForComparison(path);
    if (!shown.has(key) && !missing.has(key)) missing.set(key, path);
  }
  if (missing.size === 0) return text;
  const end = unclosedBlockEnd(text);
  let result = end === undefined ? text : `${text}${RESULT_PATTERN.test(text) ? "" : "\n"}${end}`;
  for (const path of missing.values()) {
    result += `${result.length > 0 ? "\n\n" : ""}${imageEmbed(path)}`;
  }
  return result;
}
