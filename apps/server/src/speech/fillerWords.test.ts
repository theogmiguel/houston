import { describe, expect, it } from "vite-plus/test";
import { removeSpeechFillerWords } from "./fillerWords.ts";

describe("removeSpeechFillerWords", () => {
  it("removes universal fillers and cleans whitespace", () => {
    expect(removeSpeechFillerWords("Uh, I uhm think this works.")).toBe("I think this works.");
  });

  it("only removes ambiguous fillers with matching language evidence", () => {
    expect(removeSpeechFillerWords("um I think", "en")).toBe("I think");
    expect(removeSpeechFillerWords("eu vi um carro")).toBe("eu vi um carro");
    expect(removeSpeechFillerWords("äh ich glaube ähm das passt", "de-DE")).toBe(
      "ich glaube das passt",
    );
  });

  it("keeps laughter in English", () => {
    expect(removeSpeechFillerWords("ha ha, that was funny", "en")).toBe("ha ha, that was funny");
    expect(removeSpeechFillerWords("um, ah, eh ok", "en")).toBe("ok");
  });

  it.each([
    ["ahn, eu acho que sim", "pt", "eu acho que sim"],
    ["hã, tipo assim, né", "pt-BR", "tipo assim, né"],
    ["ãh eu vi um carro é bom", "pt", "eu vi um carro é bom"],
    ["hum eu vi um carro", "pt", "eu vi um carro"],
    ["eh, bueno, este es tipo así", "es", "bueno, este es tipo así"],
    ["em vamos a ver mm sí", "es-MX", "vamos a ver sí"],
  ])("removes %j for %s", (text, language, expected) => {
    expect(removeSpeechFillerWords(text, language)).toBe(expected);
  });

  it("never strips real words in Portuguese or Spanish", () => {
    for (const language of ["pt", "es"]) {
      const real = "é tipo bueno este um uma pues o sea então né ah ha";
      expect(removeSpeechFillerWords(real, language)).toBe(real);
    }
  });

  it("applies only the language-neutral hesitations when the language is unknown", () => {
    expect(removeSpeechFillerWords("uh um ah hmm eu vi um carro")).toBe("um ah eu vi um carro");
    expect(removeSpeechFillerWords("ahn hã eh em mm", undefined)).toBe("ahn hã eh em mm");
  });

  it("does not remove fillers inside words", () => {
    expect(removeSpeechFillerWords("humming thumbnail")).toBe("humming thumbnail");
  });

  it("preserves a configured correction cue", () => {
    expect(removeSpeechFillerWords("Orange, um, yellow", "en", "um")).toBe("Orange, um, yellow");
  });
});
