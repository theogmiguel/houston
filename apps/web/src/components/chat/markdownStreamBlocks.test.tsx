import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@houston-app/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { CODING_ANSWERS } from "./markdownStreamBlocks.fixture";
import { headingIdsMayCollide, splitMarkdownBlocks } from "./markdownStreamBlocks";

// Whitespace between top-level blocks collapses in the rendered message.
const html = (source: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {source}
    </ReactMarkdown>,
  )
    .replace(/>\s+</g, "><")
    .trim();

describe("splitMarkdownBlocks", () => {
  it.each([
    "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
    "- one\n- two\n\n- loose three\n\n  continued\n\nAfter the list.",
    "1. first\n\n2. second\n\nText\n\n3) restarted",
    "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nend",
    "> quote\n\n> another quote\n\n> [!NOTE]\n> alert",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
    "para\n\n    indented code\n\nnext",
    "Setext\n===\n\nnext\n---\n\n- [ ] task\n- [x] done",
    "- a\n\n  ```\n  x\n\n```\n\nb",
    "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
  ])("renders each block as the whole text renders it, at every streamed prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source);
      expect(blocks?.join("")).toBe(source);
      expect(blocks!.map(html).join("")).toBe(html(source));
    }
  });

  it("splits only between closed blocks", () => {
    expect(splitMarkdownBlocks("a\n\n```\nb\n\nc\n```\n\n- d\n\n- e\n\nf")).toEqual([
      "a\n\n",
      "```\nb\n\nc\n```\n\n- d\n\n- e\n\n",
      "f",
    ]);
  });

  it.each([
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "<details>\n\nbody\n\n</details>",
    ":::note\n\ncontent\n\n:::",
    "$$\na\n\nb\n$$",
    "a\r\n\r\nb",
    "See [the docs][1].\n\n> [1]: https://example.com/docs",
    "- ![logo][img]\n\n- [img]: https://example.com/a.png",
    "See [foo\nbar] now.\n\n[foo\nbar]: https://example.com/fb",
    "Start <b>bold\n\nstill bold</b> end",
    "Start <!-- a\n\nb --> end",
    "- a\n\n  ```\n  x\n\ny <em>open\n\nz</em>",
    '<span id="x">a</span>\n\n## A',
  ])("keeps text with document-wide syntax whole: %j", (text) => {
    expect(splitMarkdownBlocks(text)).toBeNull();
  });

  it("splits around inline HTML that is shown as text, and around HTML in a code fence", () => {
    expect(splitMarkdownBlocks("Start <b>bold\n\nstill bold</b> end", false)).toEqual([
      "Start <b>bold\n\n",
      "still bold</b> end",
    ]);
    expect(splitMarkdownBlocks("a\n\n```html\nx <b>y\n\nz</b>\n```\n\nb")).toEqual([
      "a\n\n",
      "```html\nx <b>y\n\nz</b>\n```\n\n",
      "b",
    ]);
  });
});

describe("splitMarkdownBlocks on coding answers", () => {
  const blockCount = (text: string) =>
    text.split(/\n[ \t]*\n/).filter((block) => block.trim() !== "").length;
  const answers = CODING_ANSWERS.filter((text) => blockCount(text) >= 4);

  it("splits at least 90 % of answers with four or more blocks, streaming and finished", () => {
    expect(answers.length).toBeGreaterThanOrEqual(15);
    const streamed = answers.filter((text) => (splitMarkdownBlocks(text)?.length ?? 0) > 1);
    const finished = streamed.filter((text) => !headingIdsMayCollide(text));
    expect(streamed.length / answers.length).toBeGreaterThanOrEqual(0.9);
    expect(finished.length / answers.length).toBeGreaterThanOrEqual(0.9);
  });

  it.each(CODING_ANSWERS)("renders each block as the whole answer renders it: %j", (text) => {
    const blocks = splitMarkdownBlocks(text) ?? [text];
    expect(blocks.join("")).toBe(text);
    expect(blocks.map(html).join("")).toBe(html(text));
  });
});

describe("headingIdsMayCollide", () => {
  it.each([
    ["## Setup\n\ntext\n\n## Setup", true],
    ["## Setup\n\n## setup!", true],
    ["## Fix 1\n\n## Fix-1", true],
    ["## [Link](x)\n\n## Other", true],
    ["## A &amp; B", true],
    // An element id needs raw HTML, which keeps the text whole before ids are compared.
    ['<span id="x">a</span>\n\n## A', false],
    ["Title\n---\n\n## Other", true],
    ["> ## Quoted\n\n- ## Listed\n\n## Quoted", true],
    ["## One\n\n## Two\n\n### Three", false],
    ["```sh\n# install\n```\n\n```sh\n# install\n```\n\n## Install steps", false],
    ["## Setup\n\nText\n\n```md\n```js\nx\n```\n\n## Setup", true],
    ["No headings at all.\n\n---\n\nAfter a break.", false],
  ])("%j: %s", (text, collides) => {
    expect(headingIdsMayCollide(text)).toBe(collides);
  });
});
