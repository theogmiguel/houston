// The one normaliser for reply text: rewrites other notations to the marks Slack's message box
// accepts, refuses what it cannot show by name and line, and leaves code untouched. It is
// context-free: who may be mentioned is `checkMentions`.
import {
  FENCE,
  FENCE_CLOSE,
  LIST_ITEM,
  ListTracker,
  canClose,
  canOpen,
  indentWidth,
  lexInline,
  pairDelimiters,
  parseReply,
  type AngleKind,
  type InlineToken,
} from "./parse.ts";
import { REPLY_TEXT_LIMITS, validateReplyBlocks, type ReplyRefusal } from "./structure.ts";

export type ReplyChangeKind =
  | "bold_doubled"
  | "bold_underscores"
  | "bold_italic"
  | "strike_doubled"
  | "heading"
  | "bullet_marker"
  | "angle_link"
  | "line_break_tag"
  | "line_endings"
  | "unicode_form"
  | "trailing_spaces"
  | "blank_lines"
  | "list_numbering"
  | "fence_language"
  | "fence_split"
  | "fence_closed"
  | "fence_empty";

const CHANGE_MESSAGES: Record<ReplyChangeKind, string> = {
  bold_doubled: "`**text**` became `*text*`, Slack's bold",
  bold_underscores: "`__text__` became `*text*`, Slack's bold",
  bold_italic: "`***text***` became `*_text_*`",
  strike_doubled: "`~~text~~` became `~text~`, Slack's strikethrough",
  heading: "a `#` heading became a bold line",
  bullet_marker: "a `*` or `+` list item became `-`",
  angle_link: "a link in angle brackets became an address or `[label](address)`",
  line_break_tag: "`<br>` became a line break",
  line_endings: "line endings became line breaks",
  unicode_form: "characters were put in their composed Unicode form",
  trailing_spaces: "spaces at the end of a line were removed",
  blank_lines: "more than two blank lines became one",
  list_numbering: "a numbered list that did not start at 1 is numbered from 1",
  fence_language: "the language word after a code fence was dropped",
  fence_split: "text after an opening code fence was moved to its own line",
  fence_closed: "a code block left open was closed at the end",
  fence_empty: "an empty code block was removed",
};

export interface ReplyChange {
  readonly kind: ReplyChangeKind;
  readonly line: number;
  readonly message: string;
}

export type ReplyNormalized =
  | { readonly ok: true; readonly text: string; readonly changes: ReadonlyArray<ReplyChange> }
  | { readonly ok: false; readonly refusals: ReadonlyArray<ReplyRefusal> };

const MAX_PASSES = 4;
const MAILTO = /^mailto:/i;
const HOST_NAME = String.raw`[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)+`;
const LABEL_HOST = new RegExp(
  String.raw`^(?:[a-z][a-z0-9+.-]*:\/\/)?(${HOST_NAME})(?::\d+)?([/?#].*)?$`,
  "iu",
);
const LABEL_EMAIL = new RegExp(String.raw`^(?:mailto:)?[^\s@]+@(${HOST_NAME})$`, "iu");
const ADDRESS_TLD = /\.(?:\p{L}{2,}|xn--[a-z0-9-]+)$/iu;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const EXPLICIT_ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu;
// Characters a reader does not see, removed before a label is compared with its address.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// Characters that read as a dot and are left after NFKC: the full stops a browser reads as a
// dot, and other scripts' full stops and dots set on the line.
const DOT_LOOKALIKE =
  /[\u0589\u06d4\u0701\u0702\u2024\u2e3c\u3002\ua4f8\ua60e\ua6f3\ufe52\uff0e\uff61]/gu;
// A bare label word ending in one of these is a file name, not an address. Some of them are
// also country domains (md, py, rs, sh, ...) or new top-level domains (zip): a coding agent
// names files far more often than sites there, and a label shows the name as it is.
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "js mjs cjs ts mts cts tsx jsx json jsonc yaml yml toml ini env md mdx txt csv log " +
    "html css scss py rb go rs java kt swift php c h cpp sh sql lock xml svg png jpg jpeg " +
    "gif webp pdf zip gz tar tgz vue svelte wasm"
  ).split(" "),
);
const LABEL_WORD_SEPARATOR = /[\s,;!?()[\]<>"'|]+/u;
const WORD_EDGE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
const WWW = /^www\./;
const WEB_ADDRESS = /^(?:https?:\/\/[^\s/]|mailto:[^\s@]+@\S)/i;
const LABEL_SPECIALS = /[\\[\]]/g;
const SPECIAL_NAME = /^!(channel|here|everyone|subteam|date)\b/;
const TRAILING_SPACE = /[ \t]+$/;
const INDENTED_FENCE = /^\s+```/;
const CARRIAGE_RETURN = /\r\n?/g;
const HORIZONTAL_RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const HEADING = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/;
const OTHER_BULLET = /^([ \t]*)[*+][ \t]+(?=\S)/;
const TASK_BOX = /^\[[ xX]\](?: |$)/;
const LANGUAGE_WORD = /^[A-Za-z0-9_+.#-]+[ \t]*$/;

interface Pass {
  readonly changes: Array<ReplyChange>;
  readonly refusals: Array<ReplyRefusal>;
}

const change = (pass: Pass, kind: ReplyChangeKind, line: number) => {
  if (!pass.changes.some((entry) => entry.kind === kind && entry.line === line)) {
    pass.changes.push({ kind, line, message: `${CHANGE_MESSAGES[kind]} (line ${line})` });
  }
};
const refuse = (pass: Pass, mark: string, line: number, what: string) => {
  if (!pass.refusals.some((entry) => entry.mark === mark && entry.line === line)) {
    pass.refusals.push({ mark, line, message: `${what} (line ${line})` });
  }
};

const characterRefusals = (text: string): Array<ReplyRefusal> => {
  const pass: Pass = { changes: [], refusals: [] };
  let line = 1;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10) line += 1;
    else if ((code < 32 && code !== 9) || (code >= 0x7f && code <= 0x9f)) {
      refuse(
        pass,
        "control character",
        line,
        `A control character (U+${code.toString(16).toUpperCase().padStart(4, "0")}) cannot be sent`,
      );
    } else if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      refuse(
        pass,
        "bidirectional override",
        line,
        `A character that reorders text (U+${code.toString(16).toUpperCase()}) cannot be sent`,
      );
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      refuse(pass, "invalid character", line, "Half of a character pair cannot be sent");
    }
  }
  return pass.refusals;
};

const hostOf = (url: string): string | null => {
  if (MAILTO.test(url)) return url.slice(url.lastIndexOf("@") + 1).toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** A host as a browser opens it (lower case, punycode, dots mapped), `www.` dropped. */
const canonicalHost = (host: string): string | null => {
  try {
    return new URL(`http://${host}`).hostname.replace(WWW, "");
  } catch {
    return null;
  }
};

/** A label as a reader sees it: compatibility forms folded, invisible characters gone. */
const comparisonForm = (label: string) =>
  label.normalize("NFKC").replace(INVISIBLE, "").replace(DOT_LOOKALIKE, ".");

const isFileName = (name: string) =>
  FILE_EXTENSIONS.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase());

/** True when `name` is the host a link opens or a parent domain of it. */
const namesHost = (name: string, opens: string | null) => {
  const host = canonicalHost(name);
  return host !== null && opens !== null && (opens === host || opens.endsWith(`.${host}`));
};

// The first label word shaped as an address that is not the link's host, a parent domain of
// it or the mailto domain. A bare word that ends in a file extension is a file name.
const misleadingLabelWord = (label: string, url: string): string | null => {
  const mailto = MAILTO.test(url);
  const opens = canonicalHost(hostOf(url) ?? "");
  for (const word of comparisonForm(label).split(LABEL_WORD_SEPARATOR)) {
    const trimmed = word.replace(WORD_EDGE, "");
    const email = LABEL_EMAIL.exec(trimmed);
    if (email !== null) {
      if (!mailto || canonicalHost(email[1] as string) !== opens) return trimmed;
      continue;
    }
    const host = LABEL_HOST.exec(trimmed);
    if (host === null) continue;
    const name = host[1] as string;
    if (!ADDRESS_TLD.test(name) && !IPV4.test(name)) continue;
    if (namesHost(name, opens)) continue;
    const bare = !EXPLICIT_ADDRESS.test(trimmed) && host[2] === undefined;
    if (bare && isFileName(name)) continue;
    return trimmed;
  }
  return null;
};

const isWebAddress = (url: string) => WEB_ADDRESS.test(url);

const escapeLabel = (label: string) =>
  label.replace(LABEL_SPECIALS, (character) => `\\${character}`);

type Delimiter = InlineToken & { kind: "delimiter" };
const NO_UNDERSCORE_NEIGHBOUR = /[\p{L}\p{N}._/]/u;

const doubledRole = (token: Delimiter, previous: string, next: string) => {
  const doubled =
    (token.character === "*" && (token.count === 2 || token.count === 3)) ||
    (token.count === 2 && token.character !== "*");
  if (!doubled) return null;
  let open = canOpen(previous, next);
  let close = canClose(previous, next);
  if (token.character === "_") {
    open &&= !NO_UNDERSCORE_NEIGHBOUR.test(previous);
    close &&= !NO_UNDERSCORE_NEIGHBOUR.test(next);
  }
  return open && close ? "both" : open ? "open" : close ? "close" : null;
};

/** Pairs the marks a heading drops: Slack's bold and the other notations of it. */
const boldRole = (token: Delimiter, previous: string, next: string) => {
  if (token.character === "~") return null;
  if (token.character !== "*" || token.count !== 1) return doubledRole(token, previous, next);
  const open = canOpen(previous, next);
  const close = canClose(previous, next);
  return open && close ? "both" : open ? "open" : close ? "close" : null;
};

/** A heading's text as one bold line: its own bold marks are dropped, `***` keeps the italic. */
const headingLine = (text: string): string => {
  const tokens = lexInline(text);
  const pairs = pairDelimiters(text, tokens, boldRole);
  const inner = tokens
    .map((token, position) => {
      const raw = text.slice(token.start, token.end);
      if (token.kind !== "delimiter" || !pairs.has(position)) return raw;
      return token.character === "*" && token.count === 3 ? "_" : "";
    })
    .join("");
  return `*${inner}*`;
};

const isBoldLine = (line: string) => {
  const [block, ...rest] = parseReply(line).structure[0].elements;
  return (
    rest.length === 0 &&
    block?.type === "rich_text_section" &&
    block.elements.every((element) => element.style?.bold === true)
  );
};

const normalizeInline = (line: string, lineNumber: number, pass: Pass): string => {
  const tokens = lexInline(line);
  const pairs = pairDelimiters(line, tokens, doubledRole);
  return tokens
    .map((token, position) => {
      const raw = line.slice(token.start, token.end);
      switch (token.kind) {
        case "text": {
          const composed = raw.normalize("NFC");
          if (composed !== raw) change(pass, "unicode_form", lineNumber);
          return composed;
        }
        case "delimiter": {
          const partner = pairs.get(position);
          if (partner === undefined) return raw;
          const opens = partner > position;
          if (token.character === "*" && token.count === 3) {
            change(pass, "bold_italic", lineNumber);
            return opens ? "*_" : "_*";
          }
          change(
            pass,
            token.character === "~"
              ? "strike_doubled"
              : token.character === "_"
                ? "bold_underscores"
                : "bold_doubled",
            lineNumber,
          );
          return token.character === "~" ? "~" : "*";
        }
        case "image":
          refuse(
            pass,
            "image",
            lineNumber,
            "An image cannot be sent in a reply; link to it instead",
          );
          return raw;
        case "footnote":
          refuse(pass, "footnote", lineNumber, "Slack's message box has no footnotes");
          return raw;
        case "link": {
          if (!isWebAddress(token.url)) {
            refuse(
              pass,
              "address",
              lineNumber,
              `Only http, https and mailto addresses can be linked, not \`${token.url.slice(0, 40)}\``,
            );
          }
          const named = misleadingLabelWord(token.label, token.url);
          if (named !== null) {
            refuse(
              pass,
              "link label",
              lineNumber,
              `The link's label names ${named} but it opens ${hostOf(token.url) ?? token.url}`,
            );
          }
          return raw;
        }
        case "angle":
          return normalizeAngle(token.angle, token.body, raw, lineNumber, pass);
        default:
          return raw;
      }
    })
    .join("");
};

const normalizeAngle = (
  angle: AngleKind,
  body: string,
  raw: string,
  line: number,
  pass: Pass,
): string => {
  switch (angle) {
    case "mention":
      return raw;
    case "special": {
      const name = SPECIAL_NAME.exec(body)?.[1];
      if (name === "date")
        refuse(pass, "date mark", line, "Slack's date marks cannot be sent; write the date");
      else if (name === "subteam")
        refuse(pass, "<!subteam>", line, "A group mention cannot be sent");
      else if (name !== undefined)
        refuse(pass, `<!${name}>`, line, `\`<!${name}>\` would notify everyone; it cannot be sent`);
      else refuse(pass, "<!…>", line, "A special mention cannot be sent");
      return raw;
    }
    case "channel":
      refuse(
        pass,
        "channel link",
        line,
        "A channel link cannot be sent; name the channel in words",
      );
      return raw;
    case "break":
      change(pass, "line_break_tag", line);
      return "\n";
    case "address": {
      const [url = "", ...label] = body.split("|");
      if (!isWebAddress(url)) {
        refuse(
          pass,
          "address",
          line,
          `Only http, https and mailto addresses can be linked, not \`${url.slice(0, 40)}\``,
        );
        return raw;
      }
      change(pass, "angle_link", line);
      return label.length === 0 ? url : `[${escapeLabel(label.join("|"))}](${url})`;
    }
    case "tag":
      refuse(pass, "HTML tag", line, "HTML tags cannot be sent");
      return raw;
  }
};

const normalizePass = (text: string, pass: Pass): string => {
  const lines = text.split("\n");
  const out: Array<string> = [];
  const lists = new ListTracker();
  let fence: { opened: number; content: number } | null = null;
  let blanks: Array<number> = [];
  const flushBlanks = () => {
    if (blanks.length > 2) change(pass, "blank_lines", (blanks[0] as number) + 1);
    out.push(...(blanks.length > 2 ? [""] : blanks.map(() => "")));
    blanks = [];
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (fence !== null) {
      if (!FENCE_CLOSE.test(line)) {
        fence.content += 1;
        out.push(line);
      } else if (fence.content === 0) {
        out.splice(fence.opened, 1);
        change(pass, "fence_empty", lineNumber - 1);
        fence = null;
      } else {
        if (line !== "```") change(pass, "trailing_spaces", lineNumber);
        out.push("```");
        fence = null;
      }
      continue;
    }
    const stripped = line.replace(TRAILING_SPACE, "");
    if (stripped === "") {
      if (line !== "") change(pass, "trailing_spaces", lineNumber);
      lists.reset();
      blanks.push(index);
      continue;
    }
    flushBlanks();
    if (FENCE.test(line)) {
      lists.reset();
      const rest = line.slice(3);
      if (rest.trim() !== "" && !LANGUAGE_WORD.test(rest)) {
        change(pass, "fence_split", lineNumber);
        const single = rest.length > 3 && rest.trimEnd().endsWith("```");
        out.push("```", single ? rest.trimEnd().slice(0, -3) : rest);
        if (single) out.push("```");
        else fence = { opened: out.length - 2, content: 1 };
        continue;
      }
      if (rest !== "")
        change(pass, rest.trim() === "" ? "trailing_spaces" : "fence_language", lineNumber);
      fence = { opened: out.length, content: 0 };
      out.push("```");
      continue;
    }
    if (INDENTED_FENCE.test(line))
      refuse(
        pass,
        "code block in a list",
        lineNumber,
        "Slack cannot put a code block inside a list",
      );
    if (HORIZONTAL_RULE.test(stripped))
      refuse(pass, "horizontal rule", lineNumber, "Slack's message box has no horizontal rule");
    if (
      TABLE_DELIMITER.test(stripped) &&
      stripped.includes("|") &&
      (lines[index - 1] ?? "").includes("|")
    ) {
      const header = Math.max(1, lineNumber - 1);
      refuse(pass, "table", header, "Slack's message box cannot show a table; write it as a list");
    }
    let current = stripped;
    if (current !== line) change(pass, "trailing_spaces", lineNumber);
    const heading = HEADING.exec(current);
    if (heading !== null) {
      current = headingLine(heading[1] as string);
      change(pass, "heading", lineNumber);
    }
    const otherBullet = OTHER_BULLET.exec(current);
    if (otherBullet !== null && !HORIZONTAL_RULE.test(current)) {
      current = `${otherBullet[1] as string}- ${current.slice(otherBullet[0].length)}`;
      change(pass, "bullet_marker", lineNumber);
    }
    const item = LIST_ITEM.exec(current);
    if (item === null) {
      lists.reset();
    } else {
      const ordered = item[3] !== undefined;
      const tracked = lists.item(indentWidth(item[1] as string), ordered ? "ordered" : "bullet");
      if (ordered && tracked.newList && tracked.offset === 0 && item[3] !== "1")
        tracked.run.renumber = true;
      if (ordered && tracked.run.renumber === true && item[3] !== String(tracked.run.count)) {
        change(pass, "list_numbering", lineNumber);
        current = `${item[1] as string}${tracked.run.count}.${current.slice((item[1] as string).length + (item[3] as string).length + 1)}`;
      }
      if (TASK_BOX.test(current.slice(item[0].length))) {
        refuse(
          pass,
          "task box",
          lineNumber,
          "Slack's message box has no task boxes; write a plain list",
        );
      }
    }
    const written = normalizeInline(current, lineNumber, pass);
    if (heading !== null && !isBoldLine(written)) {
      refuse(
        pass,
        "heading",
        lineNumber,
        "A heading whose `*` or `_` marks do not pair cannot become a bold line; remove them or put `\\` before each",
      );
    }
    out.push(written);
  }
  if (fence !== null) {
    change(pass, "fence_closed", lines.length);
    if (fence.content === 0) out.splice(fence.opened, 1);
    else out.push("```");
  }
  flushBlanks();
  return out.join("\n");
};

const lineAtCharacter = (text: string, position: number) =>
  [...text].slice(0, position).filter((character) => character === "\n").length + 1;

/** Normalises reply text; `ok` means it can be shown and sent, mentions aside. */
export const normalizeReplyText = (raw: string): ReplyNormalized => {
  const changes: Array<ReplyChange> = [];
  let text = raw;
  if (text.includes("\r")) {
    const line = text.slice(0, text.indexOf("\r")).split("\n").length;
    changes.push({
      kind: "line_endings",
      line,
      message: `${CHANGE_MESSAGES.line_endings} (line ${line})`,
    });
    text = text.replace(CARRIAGE_RETURN, "\n");
  }
  const characters = characterRefusals(text);
  if (characters.length > 0) return { ok: false, refusals: characters };
  for (let round = 0; round < MAX_PASSES; round++) {
    const pass: Pass = { changes: [], refusals: [] };
    const next = normalizePass(text, pass);
    if (pass.refusals.length > 0) return { ok: false, refusals: pass.refusals };
    for (const entry of pass.changes) {
      if (!changes.some((known) => known.kind === entry.kind && known.line === entry.line))
        changes.push(entry);
    }
    if (next === text) break;
    text = next;
  }
  if (text.trim() === "")
    return {
      ok: false,
      refusals: [{ mark: "empty", line: 1, message: "The reply is empty (line 1)." }],
    };
  const length = [...text].length;
  if (length > REPLY_TEXT_LIMITS.characters) {
    const line = lineAtCharacter(text, REPLY_TEXT_LIMITS.characters);
    return {
      ok: false,
      refusals: [
        {
          mark: "length",
          line,
          limit: REPLY_TEXT_LIMITS.characters,
          value: length,
          message: `The reply has ${length} characters; the limit is ${REPLY_TEXT_LIMITS.characters} (line ${line}).`,
        },
      ],
    };
  }
  const parsed = parseReply(text);
  const bounds = validateReplyBlocks(parsed.structure, parsed.blockLines);
  if (bounds.length > 0) return { ok: false, refusals: bounds };
  return { ok: true, text, changes };
};
