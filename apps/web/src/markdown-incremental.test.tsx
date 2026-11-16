import { CHAT_MARKDOWN_REHYPE_PLUGINS } from "@houston-app/shared/markdownPipeline";
import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it, vi } from "vite-plus/test";

import { remarkCodexDirectives } from "@houston-app/shared/codexMarkdownDirectives";
import { remarkGithubAlerts } from "@houston-app/shared/markdownGithubAlerts";
import { createIncrementalMarkdownPlugin } from "./markdown-incremental";
import { remarkNormalizeListItemIndentation } from "@houston-app/shared/markdownListIndentation";

function render(source: string, incremental?: Plugin<[], Root>, parsedSources?: string[]) {
  let tree: Root | undefined;
  const observeParsing: Plugin<[], Root> = function () {
    const original = this.parser;
    if (original) {
      this.parser = (text, file) => {
        parsedSources?.push(text);
        return original(text, file);
      };
    }
  };
  const capture: Plugin<[], Root> = () => (root) => {
    tree = structuredClone(root);
  };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        observeParsing,
        capture,
        remarkGfm,
        remarkGithubAlerts,
        remarkNormalizeListItemIndentation,
        remarkCodexDirectives,
        ...(incremental ? [incremental] : []),
      ]}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {source}
    </ReactMarkdown>,
  );
  return { html, tree };
}

const prefix = "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n";

describe("incremental Markdown parsing", () => {
  it("keeps the document prefix cached when list recovery parses contain fences", () => {
    const source =
      prefix +
      "-       first block\n\n        ```ts\n        const nested = 1;\n        ```\n\n        tail";
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    expect(render(source, incremental, parsedSources)).toEqual(render(source));
    parsedSources.length = 0;
    const next = source + " more";
    expect(render(next, incremental, parsedSources)).toEqual(render(next));
    expect(parsedSources).not.toContain(next);
    expect(parsedSources.some((text) => text.startsWith("houston-markdown-inline-prefix:"))).toBe(
      true,
    );
  });

  it.each([
    "a\n===\n\nb\n---\n",
    "- first\n\n  continued\n\n- next\n",
    "> quoted\n>\n> ```js\n> abc\n> ```\n\nend",
    "<div>\nhello\n\n</div>\n\nend",
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "a | b\n--|--\na | b\n",
    "```\na\n```\n\nnext\n\n~~~\nb\n~~~\n\nmore",
    "\n\n\tcode\n\nmore",
    "text <https://example.com> *bold*",
    "> [!NOTE]\n> alert\n\n- [ ] task",
    "\uFEFFtext after a byte-order mark",
  ])("preserves the parse tree, positions, and HTML while streaming %j", (tail) => {
    const source = prefix + tail;
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it.each(["\r\n", "\r"])("preserves partial %j line endings", (newline) => {
    const source = (prefix + "next\n\n```\nlast\n```\n\nend").replaceAll("\n", newline);
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental)).toEqual(render(text));
    }
  });

  it("updates earlier references when definitions arrive after the cached prefix", () => {
    const before = "[later] and footnote[^note]\n\n" + prefix;
    const incremental = createIncrementalMarkdownPlugin();
    for (const tail of ["text", "[later]: /target", "[later]: /target\n\n[^note]: a note"]) {
      expect(render(before + tail, incremental)).toEqual(render(before + tail));
    }
  });

  it("handles edits, replacements, and repeated renders without leaking transformed nodes", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const documents = [
      prefix + "- first\n - second",
      prefix + "> [!NOTE]\n> transformed alert",
      prefix + "plain text",
      "replacement without fences",
      prefix.replace("Before", "Edited") + "edited prefix",
      prefix + "plain text",
      prefix + "plain text",
    ];
    for (const document of documents) {
      expect(render(document, incremental)).toEqual(render(document));
    }
  });

  it("does not freeze unclosed, nested, indented, or mismatched fences", () => {
    const prefixes = [
      "```\nopen\n\n",
      "````\n```\n\n",
      "> ```\n> code\n> ```\n\n",
      "- ```\n  code\n  ```\n\n",
      "    ```\n    code\n    ```\n\n",
      "<script>\n```\ncode\n```\n\n",
    ];
    for (const start of prefixes) {
      const incremental = createIncrementalMarkdownPlugin();
      for (const tail of ["", "text", "\n```\n", "\n```\n\nnext"]) {
        expect(render(start + tail, incremental)).toEqual(render(start + tail));
      }
    }
  });

  it("freezes fences closed by an indented or longer run, and not by a short or wrong one", () => {
    for (const [fence, closing, freezes] of [
      ["```", "`````", true],
      ["~~~", "   ~~~", true],
      ["````", "```", false],
      ["```", "    ```", false],
      ["```", "``` x", false],
      ["~~~", "```", false],
    ] as const) {
      const incremental = createIncrementalMarkdownPlugin();
      const start = `${fence}\ncode\n${closing}\n\n`;
      const parsedSources: string[] = [];
      // The plugin keeps the first render's parser, so the probe goes in from the start.
      expect(render(start + "text", incremental, parsedSources)).toEqual(render(start + "text"));
      parsedSources.length = 0;
      const next = start + "text more";
      expect(render(next, incremental)).toEqual(render(next));
      expect(parsedSources.includes(next), closing).toBe(!freezes);
    }
  });

  it("copies the cached prefix without structuredClone on a streamed render", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const stream = (source: string) =>
      renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={[remarkGfm, incremental]}>{source}</ReactMarkdown>,
      );
    stream(prefix + "first");
    using clones = vi.spyOn(globalThis, "structuredClone");
    for (const tail of ["first chunk", "first chunk and more", "first chunk and more again"]) {
      expect(stream(prefix + tail)).toBe(
        renderToStaticMarkup(
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{prefix + tail}</ReactMarkdown>,
        ),
      );
    }
    expect(clones).not.toHaveBeenCalled();
  });
});
