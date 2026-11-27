// The plain `text` posted beside the blocks, which a phone's notification shows. Escaped so it
// cannot mention, link or close anything; mentions print the snapshot's name.
import {
  REPLY_TEXT_LIMITS,
  type ReplyBlocks,
  type ReplyInline,
  type ReplyPerson,
} from "./structure.ts";

const escapeMrkdwn = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const plainInline = (element: ReplyInline, names: ReadonlyMap<string, string>): string => {
  switch (element.type) {
    case "text":
      return element.text;
    case "link":
      return element.text === undefined || element.text === element.url
        ? element.url
        : `${element.text} (${element.url})`;
    case "emoji":
      return `:${element.name}:`;
    case "user":
      return `@${names.get(element.user_id) ?? element.user_id}`;
  }
};

const cut = (text: string): string => {
  const characters = [...text];
  if (characters.length <= REPLY_TEXT_LIMITS.fallbackCharacters) return text;
  let kept = characters.slice(0, REPLY_TEXT_LIMITS.fallbackCharacters - 1).join("");
  const entity = kept.lastIndexOf("&");
  if (entity >= 0 && !kept.slice(entity).includes(";")) kept = kept.slice(0, entity);
  return `${kept}…`;
};

export const fallbackText = (
  blocks: ReplyBlocks,
  people: ReadonlyArray<ReplyPerson> | null,
): string => {
  const names = new Map((people ?? []).map((person) => [person.id, person.name]));
  const inline = (elements: ReadonlyArray<ReplyInline>) =>
    elements.map((element) => plainInline(element, names)).join("");
  const parts = blocks[0].elements.map((element) => {
    switch (element.type) {
      case "rich_text_section":
        return inline(element.elements);
      case "rich_text_quote":
        return inline(element.elements)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      case "rich_text_preformatted":
        return element.elements[0].text;
      case "rich_text_list":
        return element.elements
          .map((item, index) => {
            const marker =
              element.style === "bullet" ? "•" : `${(element.offset ?? 0) + index + 1}.`;
            return `${"    ".repeat(element.indent)}${marker} ${inline(item.elements)}`;
          })
          .join("\n");
    }
  });
  return cut(escapeMrkdwn(parts.join("\n")));
};
