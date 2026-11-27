// Property tests with a seeded generator. The generator builds the source text, the structure
// and the plain text together, by construction; none of them is derived with the parser.
import { describe, expect, it } from "@effect/vitest";

import { stableStringify } from "../../stableStringify.ts";
import { fallbackText } from "./fallbackText.ts";
import { checkMentions } from "./mentions.ts";
import { normalizeReplyText } from "./normalize.ts";
import { parseReply } from "./parse.ts";
import { previewModel, previewRuns, type PreviewBlock, type PreviewRun } from "./previewModel.ts";
import { SAMPLE_PEOPLE } from "./slackSamples.testkit.ts";
import {
  replyRuns,
  validateReplyBlocks,
  type ReplyBlockElement,
  type ReplyBlocks,
  type ReplyInline,
  type ReplyTextStyle,
} from "./structure.ts";

const CASES = 2_000;
const BASE_SEED = Number(process.env.REPLY_TEXT_SEED ?? 20_251_125);

const random = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (below: number) => Math.floor(next() * below);
  const pick = <T>(values: ReadonlyArray<T>): T => values[int(values.length)] as T;
  return { int, pick, chance: (p: number) => next() < p };
};
type Random = ReturnType<typeof random>;

const forEachSeed = (body: (rng: Random, seed: number) => void) => {
  for (let index = 0; index < CASES; index++) {
    const seed = BASE_SEED + index;
    try {
      body(random(seed), seed);
    } catch (error) {
      throw new Error(`failed for REPLY_TEXT_SEED=${seed}: ${String(error)}`, { cause: error });
    }
  }
};

type Style = "bold" | "italic" | "strike";
type Atom =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "styled"; readonly style: Style; readonly children: ReadonlyArray<Atom> }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "labelled"; readonly label: string; readonly url: string }
  | { readonly kind: "emoji"; readonly name: string }
  | { readonly kind: "letters"; readonly name: string }
  | { readonly kind: "mention"; readonly id: string };
type Line = ReadonlyArray<Atom>;
type Block =
  | {
      readonly kind: "para";
      readonly lines: ReadonlyArray<Line>;
      readonly blanks: ReadonlyArray<number>;
    }
  | {
      readonly kind: "list";
      readonly items: ReadonlyArray<{ level: number; ordered: boolean; line: Line }>;
    }
  | { readonly kind: "quote"; readonly lines: ReadonlyArray<Line> }
  | { readonly kind: "code"; readonly lines: ReadonlyArray<string> };

const MARK_CHARACTERS = new Set([
  "\\",
  "*",
  "_",
  "~",
  ">",
  "-",
  "[",
  "]",
  "(",
  ")",
  "<",
  ":",
  ".",
  "•",
  "`",
  "#",
]);
const WORD_CHARACTERS = [..."abcxyzAZ019éßñ日本👍,!?;'\"%=&$@|/", ...MARK_CHARACTERS];
const CODE_TEXTS = [
  "**kwargs",
  "__init__.py",
  ":500",
  "<@U0X1>",
  "\\*",
  "é",
  " x ",
  "a_b_c",
  "<br>",
  "~~x~~",
];
const CODE_LINES = [
  "  **kwargs**  ",
  "# h",
  "* item",
  "<!here>",
  "3. x",
  "| a | b |",
  "é",
  "",
  "x\ty",
];
const EMOJI = ["wave", "tada", "+1", "white_check_mark", "eyes", "rocket", "100"];
const LETTERS = ["not_an_emoji", "party_parrot", "shipit_squirrel"];
const URLS = [
  "https://x.test",
  "https://x.test/?state=open",
  "https://x.test/a_b/c-d",
  "mailto:a@x.test",
  "http://y.test/p.q",
];

// A label never reads as an address (no `.` or `@`), so the normaliser accepts it as written.
const LABEL_CHARACTERS = WORD_CHARACTERS.filter(
  (character) => character !== "." && character !== "@",
);

const genWord = (rng: Random, characters = WORD_CHARACTERS) =>
  Array.from({ length: 1 + rng.int(5) }, () => rng.pick(characters)).join("");

const genAtom = (rng: Random, styles: ReadonlyArray<Style>, budget: { links: number }): Atom => {
  const roll = rng.int(20);
  const free = (["bold", "italic", "strike"] as const).filter((style) => !styles.includes(style));
  if (roll < 3 && free.length > 0 && styles.length < 2) {
    const style = rng.pick(free);
    const children = Array.from({ length: 1 + rng.int(3) }, () =>
      genAtom(rng, [...styles, style], budget),
    );
    return { kind: "styled", style, children };
  }
  if (roll < 5) return { kind: "code", text: rng.pick(CODE_TEXTS) };
  if (roll < 7 && budget.links > 0) {
    budget.links -= 1;
    return rng.chance(0.5)
      ? { kind: "url", url: rng.pick(URLS) }
      : { kind: "labelled", label: genWord(rng, LABEL_CHARACTERS), url: rng.pick(URLS) };
  }
  if (roll === 7) return { kind: "emoji", name: rng.pick(EMOJI) };
  if (roll === 8) return { kind: "letters", name: rng.pick(LETTERS) };
  if (roll === 9) return { kind: "mention", id: rng.pick(["U0OWNER01", "U0PERSON1", "U0THIRD1"]) };
  return { kind: "word", text: genWord(rng) };
};

const genLine = (rng: Random, budget: { links: number }): Line =>
  Array.from({ length: 1 + rng.int(5) }, () => genAtom(rng, [], budget));

const genBlock = (
  rng: Random,
  previous: Block["kind"] | null,
  budget: { links: number },
): Block => {
  const kinds = (["para", "list", "quote", "code"] as const).filter(
    (kind) => kind !== previous || kind !== "para",
  );
  const kind = rng.pick(kinds);
  switch (kind) {
    case "para": {
      const lines = Array.from({ length: 1 + rng.int(3) }, () => genLine(rng, budget));
      return { kind, lines, blanks: lines.slice(1).map(() => rng.int(3)) };
    }
    case "list": {
      let level = 0;
      const items = Array.from({ length: 1 + rng.int(4) }, (_, index) => {
        level = index === 0 ? 0 : Math.max(0, Math.min(4, level + rng.pick([-2, -1, 0, 0, 1])));
        return { level, ordered: rng.chance(0.4), line: genLine(rng, budget) };
      });
      return { kind, items };
    }
    case "quote":
      return { kind, lines: Array.from({ length: 1 + rng.int(2) }, () => genLine(rng, budget)) };
    case "code": {
      const lines = Array.from({ length: 1 + rng.int(3) }, () => rng.pick(CODE_LINES));
      return {
        kind,
        lines: lines.some((line) => line.trim().length > 0) ? lines : [...lines, "x"],
      };
    }
  }
};

const genDocument = (rng: Random): ReadonlyArray<Block> => {
  const budget = { links: 18 };
  const blocks: Array<Block> = [];
  for (let index = 0, count = 1 + rng.int(5); index < count; index++) {
    blocks.push(genBlock(rng, blocks.at(-1)?.kind ?? null, budget));
  }
  return blocks;
};

const escapeWord = (text: string) =>
  [...text]
    .map((character) => (MARK_CHARACTERS.has(character) ? `\\${character}` : character))
    .join("");
const STYLE_MARK: Record<Style, string> = { bold: "*", italic: "_", strike: "~" };

const printAtom = (atom: Atom): string => {
  switch (atom.kind) {
    case "word":
      return escapeWord(atom.text);
    case "styled":
      return `${STYLE_MARK[atom.style]}${atom.children.map(printAtom).join(" ")}${STYLE_MARK[atom.style]}`;
    case "code":
      return `\`${atom.text}\``;
    case "url":
      return atom.url;
    case "labelled":
      return `[${escapeWord(atom.label)}](${atom.url})`;
    case "emoji":
    case "letters":
      return `:${atom.name}:`;
    case "mention":
      return `<@${atom.id}>`;
  }
};
const printLine = (line: Line) => line.map(printAtom).join(" ");

const listNumbers = (items: ReadonlyArray<{ level: number; ordered: boolean }>) => {
  const runs = new Map<number, { ordered: boolean; count: number }>();
  return items.map(({ level, ordered }) => {
    for (const key of runs.keys()) if (key > level) runs.delete(key);
    const run = runs.get(level);
    const next =
      run !== undefined && run.ordered === ordered
        ? { ordered, count: run.count + 1 }
        : { ordered, count: 1 };
    runs.set(level, next);
    return next.count;
  });
};

const printBlock = (block: Block, indentUnit: number): string => {
  switch (block.kind) {
    case "para":
      return block.lines
        .map(
          (line, index) =>
            `${"\n".repeat(index === 0 ? 0 : (block.blanks[index - 1] ?? 0))}${printLine(line)}`,
        )
        .join("\n");
    case "list": {
      const numbers = listNumbers(block.items);
      return block.items
        .map(
          (item, index) =>
            `${" ".repeat(item.level * indentUnit)}${item.ordered ? `${numbers[index]}.` : "-"} ${printLine(item.line)}`,
        )
        .join("\n");
    }
    case "quote":
      return block.lines.map((line) => `> ${printLine(line)}`).join("\n");
    case "code":
      return ["```", ...block.lines, "```"].join("\n");
  }
};

const printDocument = (blocks: ReadonlyArray<Block>, rng: Random): string => {
  const indentUnit = rng.pick([2, 3, 4]);
  return blocks
    .map((block, index) => {
      const previous = blocks[index - 1];
      if (previous === undefined) return printBlock(block, indentUnit);
      const mustBlank = previous.kind === block.kind;
      const separator = mustBlank || rng.chance(0.5) ? "\n\n" : "\n";
      return `${separator}${printBlock(block, indentUnit)}`;
    })
    .join("");
};

const styleOf = (styles: ReadonlyArray<Style | "code">): ReplyTextStyle | undefined => {
  if (styles.length === 0) return undefined;
  const style: { bold?: true; italic?: true; strike?: true; code?: true } = {};
  for (const name of styles) style[name] = true;
  return style;
};
const withStyle = (element: ReplyInline, styles: ReadonlyArray<Style | "code">): ReplyInline => {
  const style = styleOf(styles);
  return style === undefined ? element : { ...element, style };
};

const pushInline = (out: Array<ReplyInline>, element: ReplyInline) => {
  const last = out.at(-1);
  if (
    last?.type === "text" &&
    element.type === "text" &&
    stableStringify(last.style ?? null) === stableStringify(element.style ?? null)
  ) {
    const text = last.text + element.text;
    out[out.length - 1] =
      last.style === undefined ? { type: "text", text } : { type: "text", text, style: last.style };
    return;
  }
  out.push(element);
};

const inlineAtom = (out: Array<ReplyInline>, atom: Atom, styles: ReadonlyArray<Style>) => {
  switch (atom.kind) {
    case "word":
      return pushInline(out, withStyle({ type: "text", text: atom.text }, styles));
    case "styled":
      atom.children.forEach((child, index) => {
        if (index > 0)
          pushInline(out, withStyle({ type: "text", text: " " }, [...styles, atom.style]));
        inlineAtom(out, child, [...styles, atom.style]);
      });
      return;
    case "code":
      return pushInline(out, withStyle({ type: "text", text: atom.text }, [...styles, "code"]));
    case "url":
      return pushInline(out, withStyle({ type: "link", url: atom.url }, styles));
    case "labelled":
      return pushInline(out, withStyle({ type: "link", url: atom.url, text: atom.label }, styles));
    case "emoji":
      return pushInline(out, withStyle({ type: "emoji", name: atom.name }, styles));
    case "letters":
      return pushInline(out, withStyle({ type: "text", text: `:${atom.name}:` }, styles));
    case "mention":
      return pushInline(out, withStyle({ type: "user", user_id: atom.id }, styles));
  }
};

const inlineLines = (lines: ReadonlyArray<Line>, breaks: ReadonlyArray<string>) => {
  const out: Array<ReplyInline> = [];
  lines.forEach((line, index) => {
    if (index > 0) pushInline(out, { type: "text", text: breaks[index - 1] ?? "\n" });
    line.forEach((atom, position) => {
      if (position > 0) pushInline(out, { type: "text", text: " " });
      inlineAtom(out, atom, []);
    });
  });
  return out;
};

const expectedBlocks = (blocks: ReadonlyArray<Block>): ReplyBlocks => {
  const elements: Array<ReplyBlockElement> = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "para":
        elements.push({
          type: "rich_text_section",
          elements: inlineLines(
            block.lines,
            block.blanks.map((blank) => "\n".repeat(blank + 1)),
          ),
        });
        break;
      case "quote":
        elements.push({ type: "rich_text_quote", elements: inlineLines(block.lines, []) });
        break;
      case "code":
        elements.push({
          type: "rich_text_preformatted",
          elements: [{ type: "text", text: block.lines.join("\n") }],
        });
        break;
      case "list": {
        const runs = new Map<number, { ordered: boolean; count: number }>();
        let open: { level: number; ordered: boolean } | null = null;
        for (const item of block.items) {
          for (const key of runs.keys()) if (key > item.level) runs.delete(key);
          const run = runs.get(item.level);
          const section = {
            type: "rich_text_section" as const,
            elements: inlineLines([item.line], []),
          };
          const last = elements.at(-1);
          if (
            open !== null &&
            open.level === item.level &&
            open.ordered === item.ordered &&
            last?.type === "rich_text_list"
          ) {
            elements[elements.length - 1] = { ...last, elements: [...last.elements, section] };
            runs.set(item.level, { ordered: item.ordered, count: (run?.count ?? 0) + 1 });
            continue;
          }
          const offset =
            run !== undefined && run.ordered === item.ordered && item.ordered ? run.count : 0;
          elements.push({
            type: "rich_text_list",
            style: item.ordered ? "ordered" : "bullet",
            indent: item.level,
            border: 0,
            ...(offset > 0 ? { offset } : {}),
            elements: [section],
          });
          runs.set(item.level, {
            ordered: item.ordered,
            count: run !== undefined && run.ordered === item.ordered ? run.count + 1 : 1,
          });
          open = { level: item.level, ordered: item.ordered };
        }
        break;
      }
    }
  }
  return [{ type: "rich_text", elements }];
};

const plainOf = (blocks: ReplyBlocks): string =>
  replyRuns(blocks)
    .map((run) =>
      run.kind === "break"
        ? "\n"
        : run.kind === "user"
          ? `<@${run.value}>`
          : run.kind === "emoji"
            ? `:${run.value}:`
            : run.value,
    )
    .join("");

const EMOJI_CHARACTERS: Readonly<Record<string, string>> = {
  wave: "👋",
  tada: "🎉",
  "+1": "👍",
  white_check_mark: "✅",
  eyes: "👀",
  rocket: "🚀",
  "100": "💯",
};

const displayOf = (element: ReplyInline): string => {
  switch (element.type) {
    case "text":
      return `text:${element.text}`;
    case "link":
      return `link:${element.text ?? element.url}`;
    case "emoji":
      return `emoji:${EMOJI_CHARACTERS[element.name] ?? "missing"}`;
    case "user": {
      const person = SAMPLE_PEOPLE.find((candidate) => candidate.id === element.user_id);
      return `mention:@${person?.name ?? element.user_id}`;
    }
  }
};

/** What the generator's structure must look like on screen, from the test's own tables. */
const expectedDrawing = (blocks: ReplyBlocks): ReadonlyArray<string> =>
  blocks[0].elements.flatMap((element): ReadonlyArray<string> => {
    switch (element.type) {
      case "rich_text_preformatted":
        return [`code:${element.elements[0].text}`];
      case "rich_text_list":
        return element.elements.flatMap((item) => item.elements.map(displayOf));
      default:
        return element.elements.map(displayOf);
    }
  });

const drawnOf = (model: ReadonlyArray<PreviewBlock>): ReadonlyArray<string> =>
  model.flatMap((block): ReadonlyArray<string> => {
    const runs = (items: ReadonlyArray<PreviewRun>) =>
      items.map((run) => `${run.kind}:${run.display}`);
    switch (block.kind) {
      case "code":
        return [`code:${block.text}`];
      case "list":
        return block.items.flatMap(runs);
      default:
        return runs(block.runs);
    }
  });

const FRAGMENTS = [
  "*",
  "**",
  "***",
  "_",
  "__",
  "~",
  "~~",
  "`",
  "```",
  "```ts",
  "\n",
  "\n\n\n\n",
  " ",
  "  ",
  "\t",
  "#",
  "# ",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "3. ",
  "  - ",
  "> ",
  ">",
  "<br>",
  "<https://x.test|l>",
  "<https://x.test>",
  "<@U0X1>",
  "<!here>",
  "<#C1>",
  "[a](https://x.test)",
  "[https://a.test](https://b.test)",
  "![i](https://x.test)",
  "|",
  "|---|",
  "---",
  "\\",
  ":wave:",
  ":x",
  ":",
  "é",
  "é",
  "\r\n",
  "\r",
  "a",
  "word",
  "__init__.py",
  "**kwargs",
  "https://x.test/?state=open",
  "(",
  ")",
  "[",
  "]",
  "<",
  ">",
  "&",
  "<div>",
  "[^1]",
  "- [ ] ",
  "‮",
  "\u0007",
  "\ud800",
  "👍",
];

const randomText = (rng: Random) =>
  Array.from({ length: rng.int(30) }, () =>
    rng.chance(0.15) ? String.fromCodePoint(rng.int(0x11_0000)) : rng.pick(FRAGMENTS),
  ).join("");

describe("reply text properties", () => {
  it("normalize is idempotent and never throws on arbitrary Unicode", () => {
    forEachSeed((rng) => {
      const raw = randomText(rng);
      const once = normalizeReplyText(raw);
      if (!once.ok) {
        for (const refusal of once.refusals) {
          expect(refusal.line).toBeGreaterThanOrEqual(1);
          expect(refusal.mark.length).toBeGreaterThan(0);
          expect(refusal.message).toContain(`line ${refusal.line}`);
        }
        return;
      }
      const twice = normalizeReplyText(once.text);
      expect(twice).toEqual({ ok: true, text: once.text, changes: [] });
      expect(validateReplyBlocks(parseReply(once.text).structure)).toEqual([]);
    });
  });

  it("parse is total on arbitrary Unicode; mentions and the fallback hold", () => {
    forEachSeed((rng) => {
      const { structure } = parseReply(randomText(rng));
      if (checkMentions(structure, SAMPLE_PEOPLE).length === 0) {
        const ids = replyRuns(structure)
          .filter((run) => run.kind === "user")
          .map((run) => run.value);
        for (const id of ids) expect(SAMPLE_PEOPLE.map((person) => person.id)).toContain(id);
      }
      expect(fallbackText(structure, SAMPLE_PEOPLE).replaceAll(/&(?:amp|lt|gt);/g, "")).not.toMatch(
        /[<>&]/,
      );
    });
  });

  it("parse(print(s)) = s, the plain text is the generator's, and the source is already normal", () => {
    forEachSeed((rng) => {
      const document = genDocument(rng);
      const source = printDocument(document, rng);
      const expected = expectedBlocks(document);
      expect(normalizeReplyText(source), source).toEqual({ ok: true, text: source, changes: [] });
      const { structure } = parseReply(source);
      expect(structure, source).toEqual(expected);
      expect(stableStringify(structure)).toBe(stableStringify(expected));
      expect(plainOf(structure)).toBe(plainOf(expected));
      expect(validateReplyBlocks(structure)).toEqual([]);
    });
  });

  it("code spans and fences come out byte-equal", () => {
    forEachSeed((rng) => {
      const document = genDocument(rng);
      const source = printDocument(document, rng);
      const codeTexts = (blocks: ReplyBlocks) =>
        blocks[0].elements.flatMap((element): ReadonlyArray<string> =>
          element.type === "rich_text_preformatted"
            ? [element.elements[0].text]
            : replyRuns([{ type: "rich_text", elements: [element] }])
                .filter((run) => run.styles.includes("code"))
                .map((run) => run.value),
        );
      expect(codeTexts(parseReply(source).structure)).toEqual(codeTexts(expectedBlocks(document)));
    });
  });

  it("preview equals post: the preview of the parse is the generator's structure, as drawn", () => {
    forEachSeed((rng) => {
      const document = genDocument(rng);
      const source = printDocument(document, rng);
      const expected = expectedBlocks(document);
      const model = previewModel(parseReply(source).structure, SAMPLE_PEOPLE);
      expect(previewRuns(model), source).toEqual(replyRuns(expected));
      expect(drawnOf(model), source).toEqual(expectedDrawing(expected));
    });
  });
});
