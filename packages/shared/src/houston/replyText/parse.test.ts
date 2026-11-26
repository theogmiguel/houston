import { describe, expect, it } from "@effect/vitest";

import { stableStringify } from "../../stableStringify.ts";
import { parseReply } from "./parse.ts";
import { SLACK_SAMPLES } from "./slackSamples.testkit.ts";
import type { ReplyBlockElement, ReplyInline } from "./structure.ts";

const elementsOf = (source: string): ReadonlyArray<ReplyBlockElement> =>
  parseReply(source).structure[0].elements;

const inlineOf = (source: string): ReadonlyArray<ReplyInline> => {
  const [first, ...rest] = elementsOf(source);
  expect(rest).toEqual([]);
  if (first?.type !== "rich_text_section") throw new Error(`not one section: ${source}`);
  return first.elements;
};

describe("the eight reference messages (structures TO CONFIRM)", () => {
  it.each(SLACK_SAMPLES.map((sample) => [sample.label, sample] as const))("%s", (_, sample) => {
    expect(stableStringify(parseReply(sample.source).structure)).toBe(
      stableStringify(sample.blocks),
    );
  });

  it("sample 7 names the emoji it does not draw", () => {
    const sample = SLACK_SAMPLES[6];
    expect(sample).toBeDefined();
    const { notices } = parseReply(sample?.source ?? "");
    expect(notices).toEqual([
      {
        kind: "emoji_letters",
        name: "not_an_emoji",
        line: 1,
        message: "Houston does not draw `:not_an_emoji:`; it is sent as letters",
      },
    ]);
  });
});

describe("marks become the structure", () => {
  it("styles open after a start, a space or punctuation and close the mirror way", () => {
    expect(inlineOf("*b* _i_ ~s~ `c`")).toEqual([
      { type: "text", text: "b", style: { bold: true } },
      { type: "text", text: " " },
      { type: "text", text: "i", style: { italic: true } },
      { type: "text", text: " " },
      { type: "text", text: "s", style: { strike: true } },
      { type: "text", text: " " },
      { type: "text", text: "c", style: { code: true } },
    ]);
    expect(inlineOf("(*b*).")).toEqual([
      { type: "text", text: "(" },
      { type: "text", text: "b", style: { bold: true } },
      { type: "text", text: ")." },
    ]);
    expect(inlineOf("a*b*c snake_case_name 2*3*4")).toEqual([
      { type: "text", text: "a*b*c snake_case_name 2*3*4" },
    ]);
    expect(inlineOf("* not bold*")).not.toContainEqual(
      expect.objectContaining({ style: { bold: true } }),
    );
  });

  it("styles nest, stay on one line and never cross", () => {
    expect(inlineOf("*_x_*")).toEqual([
      { type: "text", text: "x", style: { bold: true, italic: true } },
    ]);
    expect(inlineOf("*a _b_ c*")).toEqual([
      { type: "text", text: "a ", style: { bold: true } },
      { type: "text", text: "b", style: { bold: true, italic: true } },
      { type: "text", text: " c", style: { bold: true } },
    ]);
    expect(inlineOf("*open\nclose*")).toEqual([{ type: "text", text: "*open\nclose*" }]);
    expect(inlineOf("*a _b* c_")).toEqual([
      { type: "text", text: "a _b", style: { bold: true } },
      { type: "text", text: " c_" },
    ]);
  });

  it("code spans are opaque", () => {
    expect(inlineOf("`*x* :wave: <@U1> https://x.test \\*`")).toEqual([
      { type: "text", text: "*x* :wave: <@U1> https://x.test \\*", style: { code: true } },
    ]);
    expect(inlineOf("*bold `code`*")).toEqual([
      { type: "text", text: "bold ", style: { bold: true } },
      { type: "text", text: "code", style: { bold: true, code: true } },
    ]);
  });

  it("a backslash before a mark character gives that character", () => {
    expect(inlineOf("\\*x\\* \\_y\\_ \\:wave\\: \\<@U1> \\\\")).toEqual([
      { type: "text", text: "*x* _y_ :wave: <@U1> \\" },
    ]);
    expect(inlineOf("a\\b")).toEqual([{ type: "text", text: "a\\b" }]);
  });

  it("fences become one preformatted block, its text exactly as written", () => {
    expect(elementsOf("```\n  **kwargs**  \n:500\n```")).toEqual([
      {
        type: "rich_text_preformatted",
        elements: [{ type: "text", text: "  **kwargs**  \n:500" }],
      },
    ]);
  });

  it("quote lines join into one quote", () => {
    expect(elementsOf("> a\n> *b*\nafter")).toEqual([
      {
        type: "rich_text_quote",
        elements: [
          { type: "text", text: "a\n" },
          { type: "text", text: "b", style: { bold: true } },
        ],
      },
      { type: "rich_text_section", elements: [{ type: "text", text: "after" }] },
    ]);
  });

  it("lists: `•` is a bullet, levels by indentation, a level change starts a new list", () => {
    expect(elementsOf("• a\n    • b\n• c")).toEqual([
      { type: "rich_text_list", style: "bullet", indent: 0, border: 0, elements: [section("a")] },
      { type: "rich_text_list", style: "bullet", indent: 1, border: 0, elements: [section("b")] },
      { type: "rich_text_list", style: "bullet", indent: 0, border: 0, elements: [section("c")] },
    ]);
    expect(elementsOf("1. a\n2. b\n- c")).toEqual([
      {
        type: "rich_text_list",
        style: "ordered",
        indent: 0,
        border: 0,
        elements: [section("a"), section("b")],
      },
      { type: "rich_text_list", style: "bullet", indent: 0, border: 0, elements: [section("c")] },
    ]);
  });

  it("an ordered list continued after a deeper level carries its offset", () => {
    expect(elementsOf("1. a\n2. b\n   - x\n3. c")).toEqual([
      {
        type: "rich_text_list",
        style: "ordered",
        indent: 0,
        border: 0,
        elements: [section("a"), section("b")],
      },
      { type: "rich_text_list", style: "bullet", indent: 1, border: 0, elements: [section("x")] },
      {
        type: "rich_text_list",
        style: "ordered",
        indent: 0,
        border: 0,
        offset: 2,
        elements: [section("c")],
      },
    ]);
  });

  it("a paragraph before a list is its own section with no trailing line break", () => {
    expect(elementsOf("intro\n\n- a\n\nafter\n\n\nend")).toEqual([
      { type: "rich_text_section", elements: [{ type: "text", text: "intro" }] },
      { type: "rich_text_list", style: "bullet", indent: 0, border: 0, elements: [section("a")] },
      { type: "rich_text_section", elements: [{ type: "text", text: "after\n\n\nend" }] },
    ]);
  });

  it("links: bare, labelled, mailto, with balanced trailing punctuation left out", () => {
    expect(inlineOf("(see https://x.test/a_(b)).")).toEqual([
      { type: "text", text: "(see " },
      { type: "link", url: "https://x.test/a_(b)" },
      { type: "text", text: ")." },
    ]);
    expect(inlineOf("https://x.test, then")).toEqual([
      { type: "link", url: "https://x.test" },
      { type: "text", text: ", then" },
    ]);
    expect(inlineOf("[the docs](https://x.test/d) or mailto:a@x.test")).toEqual([
      { type: "link", url: "https://x.test/d", text: "the docs" },
      { type: "text", text: " or " },
      { type: "link", url: "mailto:a@x.test" },
    ]);
    expect(inlineOf("*see https://x.test*")).toEqual([
      { type: "text", text: "see ", style: { bold: true } },
      { type: "link", url: "https://x.test", style: { bold: true } },
    ]);
  });

  it("mentions by shape and emoji by the table; characters stay characters", () => {
    expect(inlineOf("<@U0ABC> :+1: 👍 10:30:45 :nope:")).toEqual([
      { type: "user", user_id: "U0ABC" },
      { type: "text", text: " " },
      { type: "emoji", name: "+1" },
      { type: "text", text: " 👍 10:30:45 :nope:" },
    ]);
  });

  it("records the source line of each block", () => {
    expect(parseReply("a\n\n- b\n- c\n> d\n```\ne\n```\nf").blockLines).toEqual([1, 3, 5, 6, 9]);
  });
});

const section = (text: string) => ({
  type: "rich_text_section" as const,
  elements: [{ type: "text" as const, text }],
});
