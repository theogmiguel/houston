import { describe, expect, it } from "@effect/vitest";

import { normalizeReplyText } from "./normalize.ts";
import { parseReply } from "./parse.ts";
import { SLACK_SAMPLES } from "./slackSamples.testkit.ts";

const normalized = (raw: string) => {
  const result = normalizeReplyText(raw);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusals)}`);
  return result;
};

const refused = (raw: string) => {
  const result = normalizeReplyText(raw);
  if (result.ok) throw new Error(`accepted as ${JSON.stringify(result.text)}`);
  return result.refusals;
};

describe("normalizeReplyText: rewritten marks, each listed as a change", () => {
  it.each([
    ["**x**", "*x*", "bold_doubled"],
    ["a **two words** b", "a *two words* b", "bold_doubled"],
    ["__x__", "*x*", "bold_underscores"],
    ["(__x__)", "(*x*)", "bold_underscores"],
    ["***x***", "*_x_*", "bold_italic"],
    ["~~x~~", "~x~", "strike_doubled"],
    ["# Title", "*Title*", "heading"],
    ["### Title ###", "*Title*", "heading"],
    ["* item\n+ other", "- item\n- other", "bullet_marker"],
    ["  * nested", "  - nested", "bullet_marker"],
    ["<https://u.test/a|the label>", "[the label](https://u.test/a)", "angle_link"],
    ["<https://u.test/a>", "https://u.test/a", "angle_link"],
    ["<mailto:a@u.test|write>", "[write](mailto:a@u.test)", "angle_link"],
    ["a<br>b", "a\nb", "line_break_tag"],
    ["a<br/>b<br />c", "a\nb\nc", "line_break_tag"],
    ["a\r\nb\rc", "a\nb\nc", "line_endings"],
    ["é", "é", "unicode_form"],
    ["a  \nb\t", "a\nb", "trailing_spaces"],
    ["a\n\n\n\n\nb", "a\n\nb", "blank_lines"],
    ["3. a\n4. b", "1. a\n2. b", "list_numbering"],
    ["```ts\ncode\n```", "```\ncode\n```", "fence_language"],
    ["```\ncode", "```\ncode\n```", "fence_closed"],
    ["text\n```\n```\nmore", "text\nmore", "fence_empty"],
  ] as const)("%j becomes %j (%s)", (raw, text, kind) => {
    const result = normalized(raw);
    expect(result.text).toBe(text);
    expect(result.changes.map((change) => change.kind)).toContain(kind);
    for (const change of result.changes) {
      expect(change.line).toBeGreaterThanOrEqual(1);
      expect(change.message.length).toBeGreaterThan(0);
    }
  });

  it.each([
    "a__x__ b",
    "__init__.py",
    "x.__y__",
    "a/__y__/b",
    "__x__1",
    "two blank lines\n\n\nstay",
    "1. one\n2. two",
    "*bold* line",
  ])("%j is left as written", (raw) => {
    const result = normalized(raw);
    expect(result.text).toBe(raw);
    expect(result.changes).toEqual([]);
  });

  it("never touches code: spans, fences and what is inside them", () => {
    for (const raw of [
      "`**kwargs**`",
      "`__init__.py` and `~~x~~` and `e\u0301`",
      "```\n**x**  \n# h\n* item\n<br>\ne\u0301\n```",
      "```\n3. a\n<!here>\n| a | b |\n|---|---|\n```",
    ]) {
      const result = normalized(raw);
      expect(result.text).toBe(raw);
      expect(result.changes).toEqual([]);
    }
  });

  it.each([
    ["## **Summary**", "*Summary*", "Summary"],
    ["# *Bold* title", "*Bold title*", "Bold title"],
    ["# __Title__ here", "*Title here*", "Title here"],
    ["# ***x*** y", "*_x_ y*", "x y"],
    ["# a _b_ c", "*a _b_ c*", "a b c"],
    ["# 2*3 = 6", "*2*3 = 6*", "2*3 = 6"],
    ["# `**kwargs**`", "*`**kwargs**`*", "**kwargs**"],
  ] as const)("heading %j becomes %j, bold throughout", (raw, text, shown) => {
    const result = normalized(raw);
    expect(result.text).toBe(text);
    expect(result.changes.map((change) => change.kind)).toEqual(["heading"]);
    const [block, ...rest] = parseReply(result.text).structure[0].elements;
    expect(rest).toEqual([]);
    if (block?.type !== "rich_text_section") throw new Error(`not one section: ${text}`);
    expect(block.elements.every((element) => element.style?.bold === true)).toBe(true);
    expect(
      block.elements.map((element) => (element.type === "text" ? element.text : "")).join(""),
    ).toBe(shown);
  });

  it("keeps a backslash before a mark character as written", () => {
    for (const raw of ["\\*\\*x\\*\\*", "\\# not a heading", "\\* not a list", "\\<br>"]) {
      expect(normalized(raw).text).toBe(raw);
    }
  });

  it("is idempotent on every rewritten case", () => {
    for (const raw of ["**x** <br># h", "a <br>b", "<https://u.test|**x**>", "* a\n   * b"]) {
      const once = normalized(raw).text;
      const twice = normalized(once);
      expect(twice.text).toBe(once);
      expect(twice.changes).toEqual([]);
    }
  });
});

describe("normalizeReplyText: refusals name the mark and the line", () => {
  it.each([
    ["ok\n| a | b |\n|---|---|\n| 1 | 2 |", "table", 2],
    ["![a picture](https://x.test/a.png)", "image", 1],
    ["ok\n<div>x</div>", "HTML tag", 2],
    ["see[^1]", "footnote", 1],
    ["- [ ] todo", "task box", 1],
    ["- [x] done", "task box", 1],
    ["above\n---\nbelow", "horizontal rule", 2],
    ["***", "horizontal rule", 1],
    ["<!channel> hi", "<!channel>", 1],
    ["<!here>", "<!here>", 1],
    ["<!everyone>", "<!everyone>", 1],
    ["<!subteam^S0TEAM|@team>", "<!subteam>", 1],
    ["<#C0CHANNEL|general>", "channel link", 1],
    ["<!date^1700000000^{date}|today>", "date mark", 1],
    ["[a](ftp://x.test/f)", "address", 1],
    ["<ftp://x.test/f>", "address", 1],
    ["[a](javascript:alert)", "address", 1],
    ["a\u0007b", "control character", 1],
    ["ok\nab‮cd", "bidirectional override", 2],
    ["- a\n  ```\n  x\n  ```", "code block in a list", 2],
    ["[https://good.test](https://evil.test/x)", "link label", 1],
    ["ok\n# *Bold title", "heading", 2],
    ["# a *b c", "heading", 1],
    ["# **x", "heading", 1],
    ["", "empty", 1],
    ["  \n\n", "empty", 1],
  ] as const)("%j is refused as %s on line %i", (raw, mark, line) => {
    const refusals = refused(raw);
    const refusal = refusals.find((entry) => entry.mark === mark);
    expect(refusal, JSON.stringify(refusals)).toBeDefined();
    expect(refusal?.line).toBe(line);
    expect(refusal?.message).toContain(`line ${line}`);
  });

  it("accepts a label that is an address on the link's own host", () => {
    expect(normalized("[https://good.test/a](https://good.test/a)").text).toBe(
      "[https://good.test/a](https://good.test/a)",
    );
  });

  it("refuses past each bound with the limit and the value", () => {
    const cases: ReadonlyArray<readonly [string, string, number, number]> = [
      ["x".repeat(4_001), "length", 4_000, 4_001],
      [Array.from({ length: 21 }, (_, i) => `https://x.test/${i}`).join(" "), "links", 20, 21],
      [
        Array.from({ length: 41 }, (_, i) => (i % 2 === 0 ? `p${i}` : `> q${i}`)).join("\n"),
        "blocks",
        40,
        41,
      ],
      [
        ["- 1", "  - 2", "    - 3", "      - 4", "        - 5", "          - 6"].join("\n"),
        "list level",
        5,
        6,
      ],
    ];
    for (const [raw, mark, limit, value] of cases) {
      const refusal = refused(raw).find((entry) => entry.mark === mark);
      expect(refusal, mark).toMatchObject({ limit, value });
      expect(refusal?.message).toContain(String(limit));
    }
  });

  it("accepts exactly the bounds", () => {
    expect(normalizeReplyText("x".repeat(4_000)).ok).toBe(true);
    expect(
      normalizeReplyText(Array.from({ length: 20 }, (_, i) => `https://x.test/${i}`).join(" ")).ok,
    ).toBe(true);
    expect(
      normalizeReplyText(["- 1", "  - 2", "    - 3", "      - 4", "        - 5"].join("\n")).ok,
    ).toBe(true);
  });
});

describe("rows that stay as written", () => {
  it.each([
    "`**kwargs`",
    "__init__.py",
    "\\*x\\*",
    "error code: 500 comes",
    "state: open",
    "https://x.test/?state=open",
  ])("%j", (raw) => {
    const result = normalized(raw);
    expect(result.text).toBe(raw);
    expect(result.changes).toEqual([]);
  });
});

describe("the eight reference messages", () => {
  it.each(SLACK_SAMPLES.map((sample) => [sample.label, sample] as const))(
    "%s is already normal",
    (_, sample) => {
      expect(normalizeReplyText(sample.source)).toMatchObject({
        ok: true,
        text: sample.source,
        changes: [],
      });
    },
  );
});
