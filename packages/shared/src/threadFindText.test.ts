import { EnvironmentId, MessageId, ThreadId } from "@houston-app/contracts";
import type { Processor } from "unified";
import { expect, it, vi } from "vite-plus/test";
import { serializeAssistantCitation } from "./assistantCitations.ts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerContextReferences.ts";
import { searchableMessageSegments } from "./threadFindText.ts";

const parsedByGates = vi.hoisted((): string[] => []);

vi.mock(import("./markdownSyntaxGates.ts"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    remarkParseWithoutUnusedSyntax(this: Processor) {
      actual.remarkParseWithoutUnusedSyntax.call(this);
      const parse = this.parser!;
      this.parser = (document, file) => {
        parsedByGates.push(document);
        return parse(document, file);
      };
    },
  };
});

it("excludes review attachments rendered as context chips", () => {
  const text = [
    "Before **review**",
    '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">',
    "Keep **this literal** comment.",
    "```diff",
    "+ hidden patch content",
    "```",
    "</review_comment>",
    "After review",
  ].join("\n");
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Before review",
    " After review",
  ]);
});

it("excludes structured context chips without joining text across them", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: "before[hidden label](houston-context://v1/terminal/terminal_1)after",
      context: { version: 1, records: [] },
    }),
  ).toEqual(["before", "after"]);
});

it("excludes the hidden prompt of an attachment-only message", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    }),
  ).toEqual([]);
});

it("does not upgrade literal legacy tags in messages with structured context", () => {
  const text =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | visible output\n</terminal_context>";
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text,
      context: { version: 1, records: [] },
    })?.join("\n"),
  ).toContain("visible output");
  expect(searchableMessageSegments({ role: "user", streaming: false, text })).toEqual([]);
});

it("excludes repeated legacy attachments containing literal context tags", () => {
  const context =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | <terminal_context>literal</terminal_context>\n</terminal_context>";
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: `Fix this\n\n${context}\n\n${context}`,
    }),
  ).toEqual(["Fix this"]);
});

const assistantSegments = (text: string, cwd?: string) =>
  searchableMessageSegments({ role: "assistant", text, streaming: false }, cwd);

it("searches displayed prose and file-chip labels without hidden paths", () => {
  expect(
    assistantSegments("[important description](/tmp/actual.ts). `/tmp/inline-example.ts:42`"),
  ).toEqual(["important description actual.ts. inline-example.ts · L42"]);
  expect(assistantSegments("[label](src/main.ts#L3C2)", "/workspace/repo")).toEqual([
    "label main.ts · L3:C2",
  ]);
  expect(assistantSegments("[label](src/main.ts#L3C2)")).toEqual(["label"]);
});

it("keeps fence paths literal and indexes file-chip labels in user messages", () => {
  expect(assistantSegments("```text\n/tmp/file.ts:42\n```")).toEqual(["/tmp/file.ts:42\n"]);
  expect(
    searchableMessageSegments({ role: "user", text: "`/tmp/file.ts:42`", streaming: false }),
  ).toEqual(["file.ts · L42"]);
});

it("indexes nested disclosure summaries and bodies in rendered order", () => {
  expect(
    assistantSegments(
      "<details><summary>Outer</summary><p>first</p><details><summary>Inner</summary><p>second</p></details></details>",
    ),
  ).toEqual(["Outer", "first", "Inner", "second"]);
});

it("indexes the citation chip label instead of its link text", () => {
  const citation = {
    version: 1 as const,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "cited   needle",
    start: 0,
    end: 14,
    prefix: "",
    suffix: "",
  };
  const text = `Please fix ${serializeAssistantCitation(citation)} thanks`;
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Please fix cited needle thanks",
  ]);
  const commented = serializeAssistantCitation({ ...citation, comment: "my note" });
  expect(searchableMessageSegments({ role: "user", text: commented, streaming: false })).toEqual([
    "my note",
  ]);
});

it.each([
  ["a table", "| a | b |\n|---|:-:|\n| 1 | 2 |\n\nafter", ["a", "b", "1", "2", "after"]],
  [
    "autolink literals",
    "see https://example.com/a_b_ and www.example.com/x. mail me@x.io now",
    ["see https://example.com/a_b_ and www.example.com/x. mail me@x.io now"],
  ],
  ["task list items", "- [ ] todo\n- [x] done", [" todo", " done"]],
  ["strikethrough", "text~~strike~~ and H~2~O", ["textstrike and H2O"]],
  ["a footnote", "foot[^1] note\n\n[^1]: the note", ["foot1 note", "Footnotes", "the note ↩"]],
])("searches %s as the renderer shows it", (_name, text, expected) => {
  expect(searchableMessageSegments({ role: "assistant", text, streaming: false })).toEqual(
    expected,
  );
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual(expected);
});

it.each([
  ["an assistant message", "assistant", "plain reply"],
  ["an assistant message with preserved line breaks", "assistant", "★ Insight ─────\nline\nbreak"],
  ["a user message", "user", "plain request"],
] as const)("parses %s through the syntax gates", (_name, role, text) => {
  parsedByGates.length = 0;
  searchableMessageSegments({ role, text, streaming: false });
  expect(parsedByGates).toEqual([text]);
});
