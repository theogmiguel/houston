// The text a bot run's thread starts with, and the system append its every query open carries.
// Line one is built from ids alone; every other value has the block's own tags escaped.
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

/** Recorded on each bot run, so a later wording does not rewrite what an earlier run was told. */
export const OPENING_TEMPLATE = "houston-bot-1";

export interface OpeningFacts {
  readonly botRunId: string;
  readonly slug: string;
  readonly revisionN: number;
  readonly name: string;
  readonly job: string;
  readonly projectTitle: string;
  readonly otherProjectTitles: ReadonlyArray<string>;
  /** The pinned revision's text. */
  readonly instructions: string;
  readonly ownerText: string;
}

// Spaces and case do not get a tag past it: `< /HOUSTON-BOT` is escaped too.
const BLOCK_TAG = /<(\s*\/?\s*houston-bot)/gi;

const escape = (value: string) => value.replace(BLOCK_TAG, "&lt;$1");

const instructionsSection = (facts: Pick<OpeningFacts, "revisionN" | "instructions">) => [
  `## Instructions (revision ${facts.revisionN})`,
  escape(facts.instructions),
];

/** The thread's first message: the block, then what the owner typed. */
export const openingMessage = (facts: OpeningFacts): string => {
  const others =
    facts.otherProjectTitles.length === 0
      ? ""
      : ` Other projects: ${facts.otherProjectTitles.map(escape).join(", ")}.`;
  return [
    `<houston-bot run="${facts.botRunId}" bot="${facts.slug}" revision="${facts.revisionN}">`,
    "Started by: the owner, in Houston.",
    `You are ${escape(facts.name)}: ${escape(facts.job)}. You work in ${escape(facts.projectTitle)}.${others}`,
    ...instructionsSection(facts),
    "</houston-bot>",
    escape(facts.ownerText),
  ].join("\n");
};

/** What survives a reopened thread and compaction: rebuilt from the pinned revision each time. */
export const botSystemAppend = (
  facts: Pick<OpeningFacts, "name" | "job" | "revisionN" | "instructions">,
): string =>
  [
    `You are ${escape(facts.name)}, a Houston bot: ${escape(facts.job)}.`,
    ...instructionsSection(facts),
  ].join("\n");

/** Whether `text` is still the text whose hash the revision recorded. */
export const revisionMatches = Effect.fn("HoustonBots.revisionMatches")(function* (
  text: string,
  sha256: string,
) {
  const digest = yield* Digest.Digest;
  const hash = yield* digest.digest(Digest.sha256, new TextEncoder().encode(text));
  return Hex.encode(hash) === sha256;
});
