import { describe, expect, it } from "@effect/vitest";

import { STANDARD_EMOJI_COUNT, emojiCharacter } from "./emoji.ts";

describe("the standard emoji table", () => {
  it("holds at least 400 names, each with a character", () => {
    expect(STANDARD_EMOJI_COUNT).toBeGreaterThanOrEqual(400);
    for (const name of [
      "wave",
      "tada",
      "+1",
      "thumbsup",
      "heart",
      "white_check_mark",
      "eyes",
      "100",
    ]) {
      expect(emojiCharacter(name)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("knows no name the workspace may have made itself", () => {
    expect(emojiCharacter("not_an_emoji")).toBe(undefined);
    expect(emojiCharacter("party_parrot")).toBe(undefined);
  });
});
