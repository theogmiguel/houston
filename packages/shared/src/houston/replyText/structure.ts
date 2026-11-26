// The typed structure a reply is posted as: one `rich_text` block, as Slack names its parts.
// The shapes follow eight reference messages and stay "to confirm" until those are
// compared with the same messages typed by hand.

export interface ReplyTextStyle {
  readonly bold?: true;
  readonly italic?: true;
  readonly strike?: true;
  readonly code?: true;
}

export type ReplyInline =
  | { readonly type: "text"; readonly text: string; readonly style?: ReplyTextStyle }
  | {
      readonly type: "link";
      readonly url: string;
      readonly text?: string;
      readonly style?: ReplyTextStyle;
    }
  | { readonly type: "emoji"; readonly name: string; readonly style?: ReplyTextStyle }
  | { readonly type: "user"; readonly user_id: string; readonly style?: ReplyTextStyle };

export interface ReplySection {
  readonly type: "rich_text_section";
  readonly elements: ReadonlyArray<ReplyInline>;
}

export interface ReplyList {
  readonly type: "rich_text_list";
  readonly style: "bullet" | "ordered";
  readonly indent: number;
  readonly border: 0;
  /** Items of the same ordered list already shown above a deeper level. */
  readonly offset?: number;
  readonly elements: ReadonlyArray<ReplySection>;
}

export interface ReplyQuote {
  readonly type: "rich_text_quote";
  readonly elements: ReadonlyArray<ReplyInline>;
}

export interface ReplyPreformatted {
  readonly type: "rich_text_preformatted";
  readonly elements: readonly [{ readonly type: "text"; readonly text: string }];
}

export type ReplyBlockElement = ReplySection | ReplyList | ReplyQuote | ReplyPreformatted;

export interface ReplyRichText {
  readonly type: "rich_text";
  readonly elements: ReadonlyArray<ReplyBlockElement>;
}

/** The `blocks` of a post: always exactly one `rich_text` block. */
export type ReplyBlocks = readonly [ReplyRichText];

export const REPLY_TEXT_LIMITS = {
  characters: 4_000,
  links: 20,
  blocks: 40,
  listLevels: 5,
  fallbackCharacters: 3_000,
} as const;

/** A mark or a bound the reply cannot pass, with the 1-based line it starts on. */
export interface ReplyRefusal {
  readonly mark: string;
  readonly line: number;
  readonly message: string;
  readonly limit?: number;
  readonly value?: number;
}

/** One person of a reply draft's snapshot: the owner or the addressee. */
export interface ReplyPerson {
  readonly id: string;
  readonly name: string;
}

/** A flat run, the unit in which a preview and a post are compared. */
export interface ReplyRun {
  readonly kind: "text" | "link" | "emoji" | "user" | "break";
  readonly value: string;
  readonly url?: string;
  readonly styles: string;
}

const styleKey = (style: ReplyTextStyle | undefined): string =>
  (["bold", "italic", "strike", "code"] as const).filter((key) => style?.[key] === true).join("+");

export const inlineRun = (element: ReplyInline): ReplyRun => {
  const styles = styleKey(element.style);
  switch (element.type) {
    case "text":
      return { kind: "text", value: element.text, styles };
    case "link":
      return { kind: "link", value: element.text ?? element.url, url: element.url, styles };
    case "emoji":
      return { kind: "emoji", value: element.name, styles };
    case "user":
      return { kind: "user", value: element.user_id, styles };
  }
};

const blockTag = (element: ReplyBlockElement): string =>
  element.type === "rich_text_list"
    ? `list:${element.style}:${element.indent}:${element.offset ?? 0}`
    : element.type;

/** The runs of a structure, each block opened by a `break` run naming its kind. */
export const replyRuns = (blocks: ReplyBlocks): ReadonlyArray<ReplyRun> =>
  blocks[0].elements.flatMap((element): ReadonlyArray<ReplyRun> => {
    const open: ReplyRun = { kind: "break", value: blockTag(element), styles: "" };
    switch (element.type) {
      case "rich_text_section":
      case "rich_text_quote":
        return [open, ...element.elements.map(inlineRun)];
      case "rich_text_preformatted":
        return [open, { kind: "text", value: element.elements[0].text, styles: "pre" }];
      case "rich_text_list":
        return [
          open,
          ...element.elements.flatMap((item) => [
            { kind: "break", value: "item", styles: "" } satisfies ReplyRun,
            ...item.elements.map(inlineRun),
          ]),
        ];
    }
  });

const inlinesOf = (element: ReplyBlockElement): ReadonlyArray<ReplyInline> =>
  element.type === "rich_text_list"
    ? element.elements.flatMap((item) => item.elements)
    : element.type === "rich_text_preformatted"
      ? element.elements
      : element.elements;

const isEmptyInline = (element: ReplyInline): boolean =>
  (element.type === "text" && element.text.length === 0) ||
  (element.type === "link" && element.url.length === 0);

/** Bounds and shape. `blockLines` (each block's source line) lets a refusal name its line. */
export const validateReplyBlocks = (
  blocks: ReplyBlocks,
  blockLines: ReadonlyArray<number> = [],
): ReadonlyArray<ReplyRefusal> => {
  const refusals: Array<ReplyRefusal> = [];
  const elements = blocks[0].elements;
  const lineOf = (index: number) => blockLines[index] ?? 1;
  if (elements.length === 0) {
    refusals.push({ mark: "empty", line: 1, message: "The reply is empty (line 1)." });
  }
  if (elements.length > REPLY_TEXT_LIMITS.blocks) {
    const line = lineOf(REPLY_TEXT_LIMITS.blocks);
    refusals.push({
      mark: "blocks",
      line,
      limit: REPLY_TEXT_LIMITS.blocks,
      value: elements.length,
      message: `The reply has ${elements.length} paragraphs, lists, quotes and code blocks; Slack takes at most ${REPLY_TEXT_LIMITS.blocks} (line ${line}).`,
    });
  }
  let links = 0;
  let linkLine = 0;
  elements.forEach((element, index) => {
    const line = lineOf(index);
    if (element.type === "rich_text_list" && element.indent >= REPLY_TEXT_LIMITS.listLevels) {
      refusals.push({
        mark: "list level",
        line,
        limit: REPLY_TEXT_LIMITS.listLevels,
        value: element.indent + 1,
        message: `A list is nested ${element.indent + 1} levels deep; Slack shows at most ${REPLY_TEXT_LIMITS.listLevels} (line ${line}).`,
      });
    }
    const inlines = inlinesOf(element);
    if (inlines.length === 0 || inlines.some(isEmptyInline)) {
      refusals.push({
        mark: "empty",
        line,
        message: `An empty part cannot be sent (line ${line}).`,
      });
    }
    for (const inline of inlines) {
      if (inline.type !== "link") continue;
      links += 1;
      if (links === REPLY_TEXT_LIMITS.links + 1) linkLine = line;
    }
  });
  if (links > REPLY_TEXT_LIMITS.links) {
    refusals.push({
      mark: "links",
      line: linkLine,
      limit: REPLY_TEXT_LIMITS.links,
      value: links,
      message: `The reply has ${links} links; at most ${REPLY_TEXT_LIMITS.links} are sent (line ${linkLine}).`,
    });
  }
  return refusals;
};
