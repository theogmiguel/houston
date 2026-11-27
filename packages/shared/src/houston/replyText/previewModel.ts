// What the preview draws, made only from the structure that is posted. `previewRuns` flattens
// it back to runs, so a test can show that preview and post carry the same content.
import { emojiCharacter } from "./emoji.ts";
import type { ReplyBlocks, ReplyInline, ReplyPerson, ReplyRun } from "./structure.ts";

export interface PreviewRun {
  readonly kind: "text" | "link" | "emoji" | "mention";
  /** What is drawn: the text, the link's label or address, `@name`, or the emoji's character. */
  readonly display: string;
  /** The value the structure carries: text, address, emoji name or user id. */
  readonly value: string;
  readonly url?: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly code: boolean;
}

export type PreviewBlock =
  | { readonly kind: "paragraph" | "quote"; readonly runs: ReadonlyArray<PreviewRun> }
  | { readonly kind: "code"; readonly text: string }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly level: number;
      readonly start: number;
      readonly items: ReadonlyArray<ReadonlyArray<PreviewRun>>;
    };

const previewRun = (element: ReplyInline, names: ReadonlyMap<string, string>): PreviewRun => {
  const styles = {
    bold: element.style?.bold === true,
    italic: element.style?.italic === true,
    strike: element.style?.strike === true,
    code: element.style?.code === true,
  };
  switch (element.type) {
    case "text":
      return { kind: "text", display: element.text, value: element.text, ...styles };
    case "link":
      return {
        kind: "link",
        display: element.text ?? element.url,
        value: element.text ?? element.url,
        url: element.url,
        ...styles,
      };
    case "emoji":
      return {
        kind: "emoji",
        display: emojiCharacter(element.name) ?? `:${element.name}:`,
        value: element.name,
        ...styles,
      };
    case "user":
      return {
        kind: "mention",
        display: `@${names.get(element.user_id) ?? element.user_id}`,
        value: element.user_id,
        ...styles,
      };
  }
};

export const previewModel = (
  blocks: ReplyBlocks,
  people: ReadonlyArray<ReplyPerson> | null = null,
): ReadonlyArray<PreviewBlock> => {
  const names = new Map((people ?? []).map((person) => [person.id, person.name]));
  const runs = (elements: ReadonlyArray<ReplyInline>) =>
    elements.map((element) => previewRun(element, names));
  return blocks[0].elements.map((element): PreviewBlock => {
    switch (element.type) {
      case "rich_text_section":
        return { kind: "paragraph", runs: runs(element.elements) };
      case "rich_text_quote":
        return { kind: "quote", runs: runs(element.elements) };
      case "rich_text_preformatted":
        return { kind: "code", text: element.elements[0].text };
      case "rich_text_list":
        return {
          kind: "list",
          ordered: element.style === "ordered",
          level: element.indent,
          start: (element.offset ?? 0) + 1,
          items: element.elements.map((item) => runs(item.elements)),
        };
    }
  });
};

const RUN_KIND: Record<PreviewRun["kind"], ReplyRun["kind"]> = {
  text: "text",
  link: "link",
  emoji: "emoji",
  mention: "user",
};

const flatRun = (run: PreviewRun): ReplyRun => {
  const styles = (["bold", "italic", "strike", "code"] as const)
    .filter((key) => run[key])
    .join("+");
  return run.url === undefined
    ? { kind: RUN_KIND[run.kind], value: run.value, styles }
    : { kind: RUN_KIND[run.kind], value: run.value, url: run.url, styles };
};

/** The preview's runs, in the shape `replyRuns` gives for a structure. */
export const previewRuns = (model: ReadonlyArray<PreviewBlock>): ReadonlyArray<ReplyRun> =>
  model.flatMap((block): ReadonlyArray<ReplyRun> => {
    switch (block.kind) {
      case "paragraph":
      case "quote":
        return [
          {
            kind: "break",
            value: block.kind === "paragraph" ? "rich_text_section" : "rich_text_quote",
            styles: "",
          },
          ...block.runs.map(flatRun),
        ];
      case "code":
        return [
          { kind: "break", value: "rich_text_preformatted", styles: "" },
          { kind: "text", value: block.text, styles: "pre" },
        ];
      case "list":
        return [
          {
            kind: "break",
            value: `list:${block.ordered ? "ordered" : "bullet"}:${block.level}:${block.start - 1}`,
            styles: "",
          },
          ...block.items.flatMap((item) => [
            { kind: "break", value: "item", styles: "" } satisfies ReplyRun,
            ...item.map(flatRun),
          ]),
        ];
    }
  });
