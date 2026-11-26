// The one conversion: normalised reply text to the structure that is previewed and posted.
// Total for every string; the normaliser decides what may be sent.
import { emojiCharacter } from "./emoji.ts";
import type {
  ReplyBlockElement,
  ReplyBlocks,
  ReplyInline,
  ReplySection,
  ReplyTextStyle,
} from "./structure.ts";

/** Characters a backslash turns into letters. */
export const REPLY_MARK_CHARACTERS: ReadonlySet<string> = new Set("\\*_~>-[]()<:.•`#");

export type AngleKind = "mention" | "special" | "channel" | "address" | "break" | "tag";

export type InlineToken = { readonly start: number; readonly end: number } & (
  | { readonly kind: "text" }
  | { readonly kind: "escape"; readonly character: string }
  | { readonly kind: "code"; readonly body: string }
  | { readonly kind: "angle"; readonly angle: AngleKind; readonly body: string }
  | { readonly kind: "link"; readonly label: string; readonly url: string }
  | { readonly kind: "image" }
  | { readonly kind: "footnote" }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "emoji"; readonly name: string }
  | { readonly kind: "delimiter"; readonly character: string; readonly count: number }
);

const ALNUM = /[\p{L}\p{N}]/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
const BARE_SCHEME = /(?:https?:\/\/[^\s/]|mailto:[^\s@]+@)/iy;
const EMOJI = /:([a-z0-9_+-]+):/y;
const MENTION_BODY = /^@[UW][A-Z0-9]+$/;
const CHANNEL_BODY = /^#C/;
const BREAK_BODY = /^br\s*\/?$/i;
const ADDRESS_BODY = /^[a-z][a-z0-9+.-]*:/i;
const TAG_BODY = /^\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^]*)?\/?$/;
const URL_END = /[\s<>`\\]/u;

const stickyMatch = (pattern: RegExp, text: string, at: number) => {
  pattern.lastIndex = at;
  return pattern.exec(text);
};

const classifyAngle = (body: string): AngleKind | null => {
  if (MENTION_BODY.test(body)) return "mention";
  if (body.startsWith("!")) return "special";
  if (CHANNEL_BODY.test(body)) return "channel";
  if (BREAK_BODY.test(body)) return "break";
  if (ADDRESS_BODY.test(body)) return "address";
  if (TAG_BODY.test(body)) return "tag";
  return null;
};

/** `[label](url)` at `open`: the label's escapes resolved, the url's parentheses balanced. */
const scanLink = (line: string, open: number) => {
  let label = "";
  let index = open + 1;
  while (index < line.length && line[index] !== "]") {
    const character = line[index] as string;
    if (character === "[") return null;
    if (character === "\\" && REPLY_MARK_CHARACTERS.has(line[index + 1] ?? "")) {
      label += line[index + 1];
      index += 2;
      continue;
    }
    label += character;
    index += 1;
  }
  if (line[index] !== "]" || line[index + 1] !== "(") return null;
  let depth = 1;
  let end = index + 2;
  for (; end < line.length; end++) {
    const character = line[end] as string;
    if (SPACE.test(character)) return null;
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) break;
  }
  const url = line.slice(index + 2, end);
  return depth === 0 && url.length > 0 ? { label, url, end: end + 1 } : null;
};

const count = (text: string, character: string) => text.split(character).length - 1;

const scanBareUrl = (line: string, start: number): string | null => {
  if (stickyMatch(BARE_SCHEME, line, start) === null) return null;
  let end = start;
  while (end < line.length && !URL_END.test(line[end] as string)) end += 1;
  let url = line.slice(start, end);
  for (;;) {
    const last = url.at(-1) ?? "";
    if (".,;:!?'\"*_~".includes(last)) url = url.slice(0, -1);
    else if (last === ")" && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
    else if (last === "]" && count(url, "[") < count(url, "]")) url = url.slice(0, -1);
    else break;
  }
  return stickyMatch(BARE_SCHEME, url, 0) === null ? null : url;
};

/** Splits one line into the tokens both the normaliser and the parser read. */
export const lexInline = (line: string): ReadonlyArray<InlineToken> => {
  const tokens: Array<InlineToken> = [];
  const pushText = (start: number, end: number) => {
    const last = tokens.at(-1);
    if (last?.kind === "text" && last.end === start)
      tokens[tokens.length - 1] = { kind: "text", start: last.start, end };
    else tokens.push({ kind: "text", start, end });
  };
  let index = 0;
  while (index < line.length) {
    const character = line[index] as string;
    const previous = line[index - 1] ?? "";
    if (character === "\\" && REPLY_MARK_CHARACTERS.has(line[index + 1] ?? "")) {
      tokens.push({
        kind: "escape",
        character: line[index + 1] as string,
        start: index,
        end: index + 2,
      });
      index += 2;
      continue;
    }
    if (character === "`") {
      const close = line.indexOf("`", index + 1);
      if (close > index + 1) {
        tokens.push({
          kind: "code",
          body: line.slice(index + 1, close),
          start: index,
          end: close + 1,
        });
        index = close + 1;
        continue;
      }
    }
    if (character === "<") {
      const close = line.indexOf(">", index + 1);
      const body = close > index + 1 ? line.slice(index + 1, close) : "";
      const angle = body.includes("<") ? null : classifyAngle(body);
      if (angle !== null) {
        tokens.push({ kind: "angle", angle, body, start: index, end: close + 1 });
        index = close + 1;
        continue;
      }
    }
    if (character === "[" && line[index + 1] === "^") {
      const close = line.indexOf("]", index + 2);
      if (close > index + 2 && !SPACE.test(line.slice(index + 2, close))) {
        tokens.push({ kind: "footnote", start: index, end: close + 1 });
        index = close + 1;
        continue;
      }
    }
    if (character === "[" || (character === "!" && line[index + 1] === "[")) {
      const link = scanLink(line, character === "!" ? index + 1 : index);
      if (link !== null) {
        tokens.push(
          character === "!"
            ? { kind: "image", start: index, end: link.end }
            : { kind: "link", label: link.label, url: link.url, start: index, end: link.end },
        );
        index = link.end;
        continue;
      }
    }
    if (
      (character === "h" || character === "H" || character === "m" || character === "M") &&
      !ALNUM.test(previous)
    ) {
      const url = scanBareUrl(line, index);
      if (url !== null) {
        tokens.push({ kind: "url", url, start: index, end: index + url.length });
        index += url.length;
        continue;
      }
    }
    if (character === ":" && !ALNUM.test(previous) && previous !== ":") {
      const match = stickyMatch(EMOJI, line, index);
      const after = line[index + (match?.[0].length ?? 0)] ?? "";
      if (match !== null && !ALNUM.test(after) && after !== ":") {
        tokens.push({
          kind: "emoji",
          name: match[1] as string,
          start: index,
          end: index + match[0].length,
        });
        index += match[0].length;
        continue;
      }
    }
    if (character === "*" || character === "_" || character === "~") {
      let end = index;
      while (line[end] === character) end += 1;
      tokens.push({ kind: "delimiter", character, count: end - index, start: index, end });
      index = end;
      continue;
    }
    pushText(index, index + 1);
    index += 1;
  }
  return tokens;
};

/** The neighbour of a token: `""` at the line's edge, a letter for an escaped character. */
export const neighbours = (line: string, tokens: ReadonlyArray<InlineToken>, position: number) => {
  const token = tokens[position] as InlineToken;
  const before = tokens[position - 1];
  const after = tokens[position + 1];
  return {
    previous: before?.kind === "escape" ? "a" : (line[token.start - 1] ?? ""),
    next: after?.kind === "escape" ? "a" : (line[token.end] ?? ""),
  };
};

const isBoundary = (character: string) =>
  character === "" || SPACE.test(character) || PUNCTUATION.test(character);
export const canOpen = (previous: string, next: string) =>
  isBoundary(previous) && next !== "" && !SPACE.test(next);
export const canClose = (previous: string, next: string) =>
  previous !== "" && !SPACE.test(previous) && isBoundary(next);

/** Pairs delimiters of `count` characters: the innermost opener of the same character wins. */
export const pairDelimiters = (
  line: string,
  tokens: ReadonlyArray<InlineToken>,
  accepts: (
    token: InlineToken & { kind: "delimiter" },
    previous: string,
    next: string,
  ) => "open" | "close" | "both" | null,
): ReadonlyMap<number, number> => {
  const pairs = new Map<number, number>();
  const stack: Array<number> = [];
  tokens.forEach((token, position) => {
    if (token.kind !== "delimiter") return;
    const { previous, next } = neighbours(line, tokens, position);
    const role = accepts(token, previous, next);
    if (role === "close" || role === "both") {
      const match = stack.findLastIndex((open) => {
        const opener = tokens[open] as InlineToken & { kind: "delimiter" };
        return opener.character === token.character && opener.count === token.count;
      });
      if (match >= 0) {
        pairs.set(stack[match] as number, position);
        pairs.set(position, stack[match] as number);
        stack.length = match;
        return;
      }
    }
    if (role === "open" || role === "both") stack.push(position);
  });
  return pairs;
};

const STYLE_OF: Record<string, keyof ReplyTextStyle> = { "*": "bold", _: "italic", "~": "strike" };

export interface ReplyNotice {
  readonly kind: "emoji_letters";
  readonly name: string;
  readonly line: number;
  readonly message: string;
}

const styleFrom = (
  active: ReadonlyMap<keyof ReplyTextStyle, number>,
  code: boolean,
): ReplyTextStyle | undefined => {
  const style: { -readonly [K in keyof ReplyTextStyle]?: true } = {};
  for (const key of ["bold", "italic", "strike"] as const)
    if ((active.get(key) ?? 0) > 0) style[key] = true;
  if (code) style.code = true;
  return Object.keys(style).length === 0 ? undefined : style;
};

const withStyle = <T extends ReplyInline>(
  element: T,
  style: ReplyTextStyle | undefined,
): ReplyInline => (style === undefined ? element : { ...element, style });

const sameStyle = (left: ReplyTextStyle | undefined, right: ReplyTextStyle | undefined) =>
  (["bold", "italic", "strike", "code"] as const).every((key) => left?.[key] === right?.[key]);

const pushInline = (out: Array<ReplyInline>, element: ReplyInline) => {
  const last = out.at(-1);
  if (element.type === "text" && last?.type === "text" && sameStyle(last.style, element.style)) {
    out[out.length - 1] = withStyle({ type: "text", text: last.text + element.text }, last.style);
  } else {
    out.push(element);
  }
};

const singleDelimiter = (
  token: InlineToken & { kind: "delimiter" },
  previous: string,
  next: string,
) => {
  if (token.count !== 1) return null;
  const open = canOpen(previous, next);
  const close = canClose(previous, next);
  return open && close ? "both" : open ? "open" : close ? "close" : null;
};

const parseInline = (
  line: string,
  lineNumber: number,
  out: Array<ReplyInline>,
  notices: Array<ReplyNotice>,
) => {
  const tokens = lexInline(line);
  const pairs = pairDelimiters(line, tokens, singleDelimiter);
  const active = new Map<keyof ReplyTextStyle, number>();
  const text = (value: string, code = false) =>
    pushInline(out, withStyle({ type: "text", text: value }, styleFrom(active, code)));
  tokens.forEach((token, position) => {
    const raw = line.slice(token.start, token.end);
    switch (token.kind) {
      case "delimiter": {
        const partner = pairs.get(position);
        if (partner === undefined) return text(raw);
        const key = STYLE_OF[token.character] as keyof ReplyTextStyle;
        active.set(key, (active.get(key) ?? 0) + (partner > position ? 1 : -1));
        return;
      }
      case "escape":
        return text(token.character);
      case "code":
        return text(token.body, true);
      case "link":
        return pushInline(
          out,
          withStyle(
            token.label.length > 0
              ? { type: "link", url: token.url, text: token.label }
              : { type: "link", url: token.url },
            styleFrom(active, false),
          ),
        );
      case "url":
        return pushInline(
          out,
          withStyle({ type: "link", url: token.url }, styleFrom(active, false)),
        );
      case "emoji":
        if (emojiCharacter(token.name) !== undefined) {
          return pushInline(
            out,
            withStyle({ type: "emoji", name: token.name }, styleFrom(active, false)),
          );
        }
        if (!notices.some((notice) => notice.name === token.name)) {
          notices.push({
            kind: "emoji_letters",
            name: token.name,
            line: lineNumber,
            message: `Houston does not draw \`:${token.name}:\`; it is sent as letters`,
          });
        }
        return text(raw);
      case "angle":
        if (token.angle === "mention") {
          return pushInline(
            out,
            withStyle({ type: "user", user_id: token.body.slice(1) }, styleFrom(active, false)),
          );
        }
        return text(raw);
      default:
        return text(raw);
    }
  });
};

export const LIST_ITEM = /^([ \t]*)(?:([-•])|(\d{1,9})\.)[ \t]+(?=\S)/;
export const FENCE = /^```/;
export const FENCE_CLOSE = /^```[ \t]*$/;
const QUOTE = /^>(?: |$)/;

export const indentWidth = (indent: string) =>
  [...indent].reduce((width, c) => width + (c === "\t" ? 4 : 1), 0);

export interface ListRun {
  readonly style: "bullet" | "ordered";
  count: number;
  renumber?: boolean;
}

/** Levels and list runs of consecutive items, shared by the parser and the normaliser. */
export class ListTracker {
  private stack: Array<number> = [];
  private runs = new Map<number, ListRun>();
  private open: { level: number; style: string } | null = null;

  reset(): void {
    this.stack = [];
    this.runs.clear();
    this.open = null;
  }

  item(width: number, style: "bullet" | "ordered") {
    while ((this.stack.at(-1) ?? -1) > width) this.stack.pop();
    const top = this.stack.at(-1);
    if (top === undefined || width >= top + 2) this.stack.push(width);
    const level = this.stack.length - 1;
    for (const key of this.runs.keys()) if (key > level) this.runs.delete(key);
    const run = this.runs.get(level);
    if (
      run !== undefined &&
      run.style === style &&
      this.open?.level === level &&
      this.open.style === style
    ) {
      run.count += 1;
      return { level, newList: false, offset: 0, run };
    }
    const offset = run !== undefined && run.style === style ? run.count : 0;
    const next: ListRun = offset > 0 && run !== undefined ? run : { style, count: 0 };
    next.count += 1;
    this.runs.set(level, next);
    this.open = { level, style };
    return { level, newList: true, offset: style === "ordered" ? offset : 0, run: next };
  }
}

export interface ParsedReply {
  readonly structure: ReplyBlocks;
  readonly notices: ReadonlyArray<ReplyNotice>;
  /** The 1-based source line each block starts on. */
  readonly blockLines: ReadonlyArray<number>;
}

export const parseReply = (text: string): ParsedReply => {
  const lines = text.split("\n");
  const elements: Array<ReplyBlockElement> = [];
  const blockLines: Array<number> = [];
  const notices: Array<ReplyNotice> = [];
  const lists = new ListTracker();
  let paragraph: Array<number> = [];

  const inlineOfLines = (indexes: ReadonlyArray<number>, cut: (line: string) => string) => {
    const out: Array<ReplyInline> = [];
    indexes.forEach((lineIndex, position) => {
      if (position > 0) pushInline(out, { type: "text", text: "\n" });
      parseInline(cut(lines[lineIndex] as string), lineIndex + 1, out, notices);
    });
    return out;
  };
  const flush = () => {
    const isBlank = (index: number) => (lines[index] ?? "").trim() === "";
    while (paragraph.length > 0 && isBlank(paragraph[0] as number)) paragraph.shift();
    while (paragraph.length > 0 && isBlank(paragraph.at(-1) as number)) paragraph.pop();
    if (paragraph.length > 0) {
      blockLines.push((paragraph[0] as number) + 1);
      elements.push({
        type: "rich_text_section",
        elements: inlineOfLines(paragraph, (line) => line),
      });
    }
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    const item = LIST_ITEM.exec(line);
    if (item === null) lists.reset();
    if (FENCE.test(line)) {
      flush();
      const body: Array<string> = [];
      const start = index;
      for (index += 1; index < lines.length && !FENCE_CLOSE.test(lines[index] as string); index++) {
        body.push(lines[index] as string);
      }
      blockLines.push(start + 1);
      elements.push({
        type: "rich_text_preformatted",
        elements: [{ type: "text", text: body.join("\n") }],
      });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: Array<number> = [];
      while (index < lines.length && QUOTE.test(lines[index] as string)) quoted.push(index++);
      index -= 1;
      const content = inlineOfLines(quoted, (quotedLine) => quotedLine.slice(2));
      if (content.some((element) => element.type !== "text" || element.text.trim() !== "")) {
        flush();
        blockLines.push((quoted[0] as number) + 1);
        elements.push({ type: "rich_text_quote", elements: content });
      } else {
        paragraph.push(...quoted);
      }
      continue;
    }
    if (item !== null) {
      flush();
      const style = item[2] === undefined ? "ordered" : "bullet";
      const tracked = lists.item(indentWidth(item[1] as string), style);
      const section: ReplySection = {
        type: "rich_text_section",
        elements: inlineOfLines([index], (itemLine) => itemLine.slice((item[0] as string).length)),
      };
      const last = elements.at(-1);
      if (!tracked.newList && last?.type === "rich_text_list") {
        elements[elements.length - 1] = { ...last, elements: [...last.elements, section] };
      } else {
        blockLines.push(index + 1);
        elements.push({
          type: "rich_text_list",
          style,
          indent: tracked.level,
          border: 0,
          ...(tracked.offset > 0 ? { offset: tracked.offset } : {}),
          elements: [section],
        });
      }
      continue;
    }
    paragraph.push(index);
  }
  flush();
  return { structure: [{ type: "rich_text", elements }], notices, blockLines };
};
