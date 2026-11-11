import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";
import { remarkParseWithoutUnusedSyntax } from "./markdownSyntaxGates.ts";

// Each text exercises a construct a gate can skip or must keep: tables (also quoted, fenced and
// lazy), autolinks, task lists, strikethrough, footnotes, plus line endings and a byte order mark.
const CORPUS: Readonly<Record<string, string>> = {
  table: "| a | b |\n|---|:-:|\n| 1 | 2 |\n\nafter",
  "table without outer pipes": "a | b\n--|--\n1 | 2",
  "quoted table": "> | a | b |\n> |---|---|\n> | x | y |",
  "table rows after a blank cell": "| a | b |\n| - | - |\n|   | 2 |\n| 3 |   |",
  "table in a fence": "```ts\n| not | table |\n|--|--|\n```",
  "rules, not tables": "-----\n\n---|---\n",
  autolinks: "see https://example.com/a_b_ and www.example.com/x. mail me@x.io now",
  "escaped www": "a literal www\\.x.io and <https://auto.link> and http://x.y/z*_",
  "autolink in emphasis": "**bold**_https://x.y_ trailing https://q.r/s**",
  "at signs": "text with @mention and user@host.com and a@b",
  "task list": "- [ ] todo\n- [x] done\n- [X] Done",
  "open task only": "- [ ] only open",
  strikethrough: "text~~strike~~ and ~sub~ plus H~2~O",
  footnote: "foot[^1] note\n\n[^1]: the note",
  "definition and file links":
    "ref [x][a]\n\n[a]: ./file.ts:12\n\n`src/a.ts:10` and [a](src/b.ts#L3)",
  "raw html": "<div>raw <b>html</b></div>\n\n<a href='x'>y</a>",
  "mixed line endings": "line one\nline two\r\nline three\rline four",
  "byte order mark": "\u{FEFF}| a | b |\n|---|---|\n| 1 | 2 |\nhttps://x.y",
  math: "$$x$$ and $y$ and $$\nz\n$$",
  prose: "Plain prose with nothing GFM-specific in it.\n\nA second paragraph.",
  empty: "",
};

const plain = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
const gated = unified()
  .use(remarkParse)
  .use(remarkParseWithoutUnusedSyntax)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS);

describe("remarkParseWithoutUnusedSyntax", () => {
  it.each(Object.entries(CORPUS))("parses %s to the tree remark-parse builds", (_name, text) => {
    expect(gated.runSync(gated.parse(text))).toEqual(plain.runSync(plain.parse(text)));
  });

  it("keeps a table that a later part of the text introduces", () => {
    const text = "intro without a table\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const tree = gated.parse(text);
    expect(tree.children.map((node) => node.type)).toEqual(["paragraph", "table"]);
  });

  it("parses every text the same after parsing a different one", () => {
    for (const text of [...Object.values(CORPUS), ...Object.values(CORPUS).reverse()]) {
      expect(gated.parse(text)).toEqual(plain.parse(text));
    }
  });
});
