import { describe, expect, it } from "@effect/vitest";

import { fallbackText } from "./fallbackText.ts";
import { replyFingerprint } from "./fingerprint.ts";
import { parseReply } from "./parse.ts";
import {
  SAMPLE_OWNER,
  SAMPLE_PEOPLE,
  SLACK_SAMPLES,
  sampleFingerprintInput,
} from "./slackSamples.testkit.ts";

describe("replyFingerprint", () => {
  it.each(SLACK_SAMPLES.map((sample, index) => [sample.label, sample, index] as const))(
    "sample %s has its pinned hash (TO CONFIRM)",
    (_, sample, index) => {
      const fromSource = parseReply(sample.source).structure;
      const input = sampleFingerprintInput(sample, index);
      expect(
        replyFingerprint({
          ...input,
          blocks: fromSource,
          text: fallbackText(fromSource, SAMPLE_PEOPLE),
        }),
      ).toBe(sample.fingerprint);
      expect(sample.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it("changes when any field changes", () => {
    const sample = SLACK_SAMPLES[0];
    if (sample === undefined) throw new Error("no sample");
    const base = sampleFingerprintInput(sample, 0);
    const reference = replyFingerprint(base);
    const variants = [
      { ...base, connectionId: "scexample00000002" },
      { ...base, conversationId: "D0EXAMPLE2" },
      { ...base, rootTs: "1700000000.000100" },
      { ...base, draftId: "draft-other" },
      { ...base, text: `${base.text} ` },
      { ...base, blocks: parseReply("Test one").structure },
      { ...base, people: [SAMPLE_OWNER, { id: "U0PERSON1", name: "Rita Renamed" }] },
      { ...base, people: [SAMPLE_OWNER] },
    ];
    for (const variant of variants) expect(replyFingerprint(variant)).not.toBe(reference);
  });

  it("does not depend on the order of object keys or on names held elsewhere", () => {
    const sample = SLACK_SAMPLES[6];
    if (sample === undefined) throw new Error("no sample");
    const input = sampleFingerprintInput(sample, 6);
    const firstDirectory = new Map([["U0OWNER01", "Someone Else"]]);
    const first = replyFingerprint(input);
    const secondDirectory = new Map([["U0OWNER01", "A Third Name"]]);
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as typeof input;
    expect(replyFingerprint(reordered)).toBe(first);
    expect(firstDirectory.get("U0OWNER01")).not.toBe(secondDirectory.get("U0OWNER01"));
    expect(replyFingerprint(input)).toBe(first);
  });
});
