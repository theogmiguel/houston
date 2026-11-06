import { describe, expect, it } from "vite-plus/test";

import {
  applySpeechAliases,
  makeSpeechTextCorrector,
  normalizeSpeechCustomWords,
} from "./customWords.ts";

const applySpeechCustomWords = (text: string, words: readonly string[]) =>
  makeSpeechTextCorrector(words)(text);

describe("speech custom words", () => {
  it.each([
    ["hello handee", ["Handy"], "hello Handy"],
    ["use Chat G P T today", ["ChatGPT"], "use ChatGPT today"],
    ["CHARGE B is ready", ["ChargeBee"], "CHARGEBEE is ready"],
    ["send it to R and D.", ["R&D"], "send it to R&D."],
    ["「Handee。」", ["Handy"], "「Handy。」"],
  ])("corrects %s", (text, words, expected) => {
    expect(applySpeechCustomWords(text, words)).toBe(expected);
  });

  it("does not fuzzily replace CJK terms", () => {
    expect(applySpeechCustomWords("你好。", ["你号"])).toBe("你好。");
    expect(applySpeechCustomWords("你好世界朋友门", ["你好世界朋友们"])).toBe("你好世界朋友门");
  });

  it.each([
    ["vamos usar a aplicaçao nova", ["Aplicação"], "vamos usar a Aplicação nova"],
    ["APLICAÇAO pronta", ["Aplicação"], "APLICAÇÃO pronta"],
    ["o senhor Muller chegou", ["Müller"], "o senhor Müller chegou"],
    ["сказал москво", ["Москва"], "сказал Москва"],
  ])("corrects the accented or non-Latin term in %j", (text, words, expected) => {
    expect(applySpeechCustomWords(text, words)).toBe(expected);
  });

  it("preserves whitespace around fuzzy corrections", () => {
    expect(applySpeechCustomWords("  hello\n\nhandee   friend\t", ["Handy"])).toBe(
      "  hello\n\nHandy   friend\t",
    );
    expect(applySpeechCustomWords("first line\nsecond line", ["Handy"])).toBe(
      "first line\nsecond line",
    );
    expect(applySpeechCustomWords("Chat\nG P T", ["ChatGPT"])).toBe("Chat\nG P T");
  });

  it("normalizes and deduplicates terms, keeping apostrophes", () => {
    expect(
      normalizeSpeechCustomWords([
        { term: "  Houston   Code ", aliases: ["Houston coat"] },
        { term: "Houston Code", aliases: [] },
        { term: "O'Brien", aliases: [] },
      ]),
    ).toEqual([
      { term: "Houston Code", aliases: ["Houston coat"] },
      { term: "O'Brien", aliases: [] },
    ]);
  });

  it("keeps a possessive on a corrected term", () => {
    expect(applySpeechCustomWords("this is handee's turn", ["Handy"])).toBe("this is Handy's turn");
  });

  it("replaces aliases as complete phrases without changing punctuation", () => {
    const words = [{ term: "MiniMax", aliases: ["mini max", "minimum max"] }];
    expect(applySpeechAliases("Use mini max, not mini maximum.", words)).toBe(
      "Use MiniMax, not mini maximum.",
    );
    expect(applySpeechAliases("Use minimum max!", words)).toBe("Use MiniMax!");
  });
});
