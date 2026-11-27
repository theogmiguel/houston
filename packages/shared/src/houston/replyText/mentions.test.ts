import { describe, expect, it } from "@effect/vitest";

import { fallbackText } from "./fallbackText.ts";
import { checkMentions } from "./mentions.ts";
import { parseReply } from "./parse.ts";
import {
  SAMPLE_ADDRESSEE,
  SAMPLE_OWNER,
  SAMPLE_PEOPLE,
  SLACK_SAMPLES,
} from "./slackSamples.testkit.ts";

const structureOf = (source: string) => parseReply(source).structure;

describe("checkMentions", () => {
  it("accepts the owner and the addressee of the snapshot", () => {
    expect(
      checkMentions(
        structureOf(`<@${SAMPLE_OWNER.id}> and <@${SAMPLE_ADDRESSEE.id}>`),
        SAMPLE_PEOPLE,
      ),
    ).toEqual([]);
  });

  it("refuses a third id by name", () => {
    expect(checkMentions(structureOf("ask <@U0THIRD1>, and *<@U0THIRD2>*"), SAMPLE_PEOPLE)).toEqual(
      [
        {
          mark: "mention",
          userId: "U0THIRD1",
          message:
            "<@U0THIRD1> is not the person this reply answers or you; a reply may mention only those two.",
        },
        {
          mark: "mention",
          userId: "U0THIRD2",
          message:
            "<@U0THIRD2> is not the person this reply answers or you; a reply may mention only those two.",
        },
      ],
    );
  });

  it("with no Slack destination, refuses any mention, the owner's too", () => {
    expect(checkMentions(structureOf(`hi <@${SAMPLE_OWNER.id}>`), null)).toEqual([
      {
        mark: "mention",
        userId: SAMPLE_OWNER.id,
        message: `<@${SAMPLE_OWNER.id}> cannot be mentioned: this reply has no Slack destination.`,
      },
    ]);
  });

  it("finds mentions in lists and quotes", () => {
    const refusals = checkMentions(structureOf("- <@U0X1>\n> <@U0X2>"), SAMPLE_PEOPLE);
    expect(refusals.map((refusal) => refusal.userId)).toEqual(["U0X1", "U0X2"]);
  });

  it("a mention exists only as a user element: text never becomes one", () => {
    const structure = structureOf("@here <!here> `<@U0X1>` \\<@U0X1>");
    expect(JSON.stringify(structure)).not.toContain('"user"');
    expect(checkMentions(structure, SAMPLE_PEOPLE)).toEqual([]);
  });
});

describe("fallbackText", () => {
  it.each(SLACK_SAMPLES.map((sample) => [sample.label, sample] as const))("%s", (_, sample) => {
    expect(fallbackText(sample.blocks, SAMPLE_PEOPLE)).toBe(sample.fallback);
  });

  it("prints the snapshot's name, else the id", () => {
    expect(fallbackText(structureOf(`<@${SAMPLE_ADDRESSEE.id}> <@U0GONE1>`), SAMPLE_PEOPLE)).toBe(
      "@Rita Example @U0GONE1",
    );
    expect(fallbackText(structureOf(`<@${SAMPLE_ADDRESSEE.id}>`), null)).toBe(
      `@${SAMPLE_ADDRESSEE.id}`,
    );
  });

  it("escapes what could mention, link or close anything", () => {
    const people = [{ id: "U0EVIL01", name: "<!channel> & <https://evil.test|x>" }];
    const text = fallbackText(structureOf("<@U0EVIL01> `a<b>&c` 1 < 2 & 3 > 2"), people);
    expect(text).toBe(
      "@&lt;!channel&gt; &amp; &lt;https://evil.test|x&gt; a&lt;b&gt;&amp;c 1 &lt; 2 &amp; 3 &gt; 2",
    );
  });

  it("is at most 3,000 characters and never cuts an escape", () => {
    const text = fallbackText(
      structureOf(`${"&".repeat(1_000)}${"x".repeat(2_000)}`),
      SAMPLE_PEOPLE,
    );
    expect([...text].length).toBeLessThanOrEqual(3_000);
    expect(text.endsWith("…")).toBe(true);
    expect(text.replaceAll("&amp;", "")).not.toContain("&");
  });
});
