// Eight reference messages, as source text and the structure each must become.
// TO CONFIRM: these are the structures Houston posts, not yet compared with what Slack
// stores for the same messages typed by hand. Compare them before the send is built.
import type {
  ReplyBlocks,
  ReplyInline,
  ReplyPerson,
  ReplySection,
  ReplyTextStyle,
} from "./structure.ts";

export const SAMPLE_OWNER: ReplyPerson = { id: "U0OWNER01", name: "Owner Example" };
export const SAMPLE_ADDRESSEE: ReplyPerson = { id: "U0PERSON1", name: "Rita Example" };
export const SAMPLE_PEOPLE: ReadonlyArray<ReplyPerson> = [SAMPLE_OWNER, SAMPLE_ADDRESSEE];

const t = (text: string, style?: ReplyTextStyle): ReplyInline =>
  style === undefined ? { type: "text", text } : { type: "text", text, style };
const section = (...elements: ReadonlyArray<ReplyInline>): ReplySection => ({
  type: "rich_text_section",
  elements,
});
const list = (style: "bullet" | "ordered", indent: number, ...items: ReadonlyArray<string>) => ({
  type: "rich_text_list" as const,
  style,
  indent,
  border: 0 as const,
  elements: items.map((item) => section(t(item))),
});
const block = (...elements: ReplyBlocks[0]["elements"]): ReplyBlocks => [
  { type: "rich_text", elements },
];

export interface SlackSample {
  readonly label: string;
  readonly source: string;
  readonly blocks: ReplyBlocks;
  readonly fallback: string;
  /** sha256 of the sample's fingerprint input; TO CONFIRM with the structures above. */
  readonly fingerprint: string;
}

export const SLACK_SAMPLES: ReadonlyArray<SlackSample> = [
  {
    label: "1 two styled lines",
    source: "Test one: *bold*, _italic_, ~struck~, `code`.\nSecond line.",
    blocks: block(
      section(
        t("Test one: "),
        t("bold", { bold: true }),
        t(", "),
        t("italic", { italic: true }),
        t(", "),
        t("struck", { strike: true }),
        t(", "),
        t("code", { code: true }),
        t(".\nSecond line."),
      ),
    ),
    fallback: "Test one: bold, italic, struck, code.\nSecond line.",
    fingerprint: "8c8daf19ba35c41bf5fc4fa660d332974c75f421bb80c92cf06657989840c956",
  },
  {
    label: "2 nested bullets",
    source: "- first\n  - nested\n- second",
    blocks: block(
      list("bullet", 0, "first"),
      list("bullet", 1, "nested"),
      list("bullet", 0, "second"),
    ),
    fallback: "• first\n    • nested\n• second",
    fingerprint: "a69cd1708e83d6884fa78f506bd2fade335783d1ec326620e725ad1ffbe30238",
  },
  {
    label: "3 numbered list after a paragraph",
    source: "Steps:\n1. one\n2. two",
    blocks: block(section(t("Steps:")), list("ordered", 0, "one", "two")),
    fallback: "Steps:\n1. one\n2. two",
    fingerprint: "e90ee7edf5f7b7cb164f821d509007743b4dfad105a02c569b999553f8679694",
  },
  {
    label: "4 quote then text",
    source: "> quoted line\nnormal text",
    blocks: block(
      { type: "rich_text_quote", elements: [t("quoted line")] },
      section(t("normal text")),
    ),
    fallback: "&gt; quoted line\nnormal text",
    fingerprint: "9610ccdf239c954730f6a5a0c8e455537c6857d60576907edc9e9155e09fb1b5",
  },
  {
    label: "5 code block",
    source: "```\none line of code\n```",
    blocks: block({
      type: "rich_text_preformatted",
      elements: [{ type: "text", text: "one line of code" }],
    }),
    fallback: "one line of code",
    fingerprint: "181d279a4bf43925a39f638794e402de874f9a5f49f1711bdd65948d2243a00e",
  },
  {
    label: "6 labelled and bare links",
    source: "A link [with a label](https://example.com/) and a bare one: https://example.com",
    blocks: block(
      section(
        t("A link "),
        { type: "link", url: "https://example.com/", text: "with a label" },
        t(" and a bare one: "),
        { type: "link", url: "https://example.com" },
      ),
    ),
    fallback: "A link with a label (https://example.com/) and a bare one: https://example.com",
    fingerprint: "e35cac3a36aa822405ebf85576cc4e06fe3aa0e722b168cf22dd1eb05ff59559",
  },
  {
    label: "7 mention and emoji",
    source:
      "Mention and emoji: <@U0OWNER01> :wave: :tada: and one typed as a character 👍. Letters that must stay letters: :not_an_emoji: and @here.",
    blocks: block(
      section(
        t("Mention and emoji: "),
        { type: "user", user_id: "U0OWNER01" },
        t(" "),
        { type: "emoji", name: "wave" },
        t(" "),
        { type: "emoji", name: "tada" },
        t(
          " and one typed as a character 👍. Letters that must stay letters: :not_an_emoji: and @here.",
        ),
      ),
    ),
    fallback:
      "Mention and emoji: @Owner Example :wave: :tada: and one typed as a character 👍. Letters that must stay letters: :not_an_emoji: and @here.",
    fingerprint: "7ce46093c675d2b1ef9455e3aede11965eb449cc0dd4931aa63b6a5831590fe4",
  },
  {
    label: "8 mixed with a blank line",
    source:
      "First paragraph with *bold*.\n\nSecond paragraph after a blank line.\n- item\nClosing line.",
    blocks: block(
      section(
        t("First paragraph with "),
        t("bold", { bold: true }),
        t(".\n\nSecond paragraph after a blank line."),
      ),
      list("bullet", 0, "item"),
      section(t("Closing line.")),
    ),
    fallback:
      "First paragraph with bold.\n\nSecond paragraph after a blank line.\n• item\nClosing line.",
    fingerprint: "838eba8632c5b585ee33ffff82983609456f0cef240a3e8fef59f1ffc9b31f3d",
  },
];

/** The fingerprint input of a sample: a synthetic connection and conversation. */
export const sampleFingerprintInput = (sample: SlackSample, index: number) => ({
  connectionId: "scexample00000001",
  conversationId: "D0EXAMPLE1",
  rootTs: "",
  draftId: `draft-sample-${index + 1}`,
  blocks: sample.blocks,
  text: sample.fallback,
  people: SAMPLE_PEOPLE,
});
