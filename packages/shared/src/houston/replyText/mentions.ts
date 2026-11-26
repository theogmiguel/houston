import type { ReplyBlocks, ReplyInline, ReplyPerson } from "./structure.ts";

export interface ReplyMentionRefusal {
  readonly mark: "mention";
  readonly userId: string;
  readonly message: string;
}

/** Every inline element of a structure, in order. */
export const replyInlines = (blocks: ReplyBlocks): ReadonlyArray<ReplyInline> =>
  blocks[0].elements.flatMap((element) =>
    element.type === "rich_text_list"
      ? element.elements.flatMap((item) => item.elements)
      : element.elements,
  );

/** Refuses, by id, every mention outside the snapshot; `people` null (no destination) refuses all. */
export const checkMentions = (
  blocks: ReplyBlocks,
  people: ReadonlyArray<ReplyPerson> | null,
): ReadonlyArray<ReplyMentionRefusal> => {
  const allowed = new Set((people ?? []).map((person) => person.id));
  const refused = new Set<string>();
  for (const element of replyInlines(blocks)) {
    if (element.type === "user" && !allowed.has(element.user_id)) refused.add(element.user_id);
  }
  return [...refused].map((userId) => ({
    mark: "mention",
    userId,
    message:
      people === null
        ? `<@${userId}> cannot be mentioned: this reply has no Slack destination.`
        : `<@${userId}> is not the person this reply answers or you; a reply may mention only those two.`,
  }));
};
