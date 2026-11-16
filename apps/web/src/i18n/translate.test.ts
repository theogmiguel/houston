import { describe, expect, it } from "vite-plus/test";

import { CATALOGUES, resolveLocale, SUPPORTED_LOCALES, translate } from "./translate";

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).toSorted();
}

describe("catalogues", () => {
  it("ships exactly English and Brazilian Portuguese", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "pt-BR"]);
  });

  it("gives every English key a Brazilian Portuguese translation", () => {
    const missing = Object.keys(CATALOGUES.en).filter((key) => !(key in CATALOGUES["pt-BR"]));
    expect(missing).toEqual([]);
  });

  it("has no Brazilian Portuguese key without an English key", () => {
    const orphaned = Object.keys(CATALOGUES["pt-BR"]).filter((key) => !(key in CATALOGUES.en));
    expect(orphaned).toEqual([]);
  });

  it("keeps the placeholders of each English string in its translation", () => {
    const mismatched = Object.entries(CATALOGUES.en).flatMap(([key, english]) => {
      const translated = CATALOGUES["pt-BR"][key];
      if (translated === undefined) return [];
      return JSON.stringify(placeholders(english)) === JSON.stringify(placeholders(translated))
        ? []
        : [`${key}: expected ${placeholders(english).join(",")}, got "${translated}"`];
    });
    expect(mismatched).toEqual([]);
  });

  it("has no empty translation", () => {
    const empty = Object.entries(CATALOGUES["pt-BR"]).filter(([, value]) => value.trim() === "");
    expect(empty).toEqual([]);
  });

  it("never translates the product name", () => {
    const renamed = Object.entries(CATALOGUES.en).filter(
      ([key, english]) =>
        english.includes("Houston") && !CATALOGUES["pt-BR"][key]?.includes("Houston"),
    );
    expect(renamed).toEqual([]);
  });
});

describe("translate", () => {
  it("returns the Brazilian Portuguese string for a known key", () => {
    expect(translate("pt-BR", "General")).toBe(CATALOGUES["pt-BR"].General);
    expect(translate("pt-BR", "General")).not.toBe("General");
  });

  it("returns the source text in English", () => {
    expect(translate("en", "General")).toBe("General");
  });

  it("falls back to the English source for a string without a translation", () => {
    expect(translate("pt-BR", "A string nobody translated")).toBe("A string nobody translated");
  });

  it("falls back to English for an unknown locale", () => {
    expect(translate("fr", "General")).toBe("General");
  });

  it("fills placeholders, also in the fallback text", () => {
    expect(translate("pt-BR", "Untranslated {count} items", { count: 3 })).toBe(
      "Untranslated 3 items",
    );
  });

  it("leaves a placeholder without a value untouched", () => {
    expect(translate("en", "Hello {name}")).toBe("Hello {name}");
  });

  it("does not re-expand placeholders inside a substituted value", () => {
    expect(translate("en", "Hello {name}", { name: "{name}" })).toBe("Hello {name}");
  });
});

describe("resolveLocale", () => {
  it("accepts a supported locale", () => {
    expect(resolveLocale("pt-BR")).toBe("pt-BR");
  });

  it("falls back to English for an unsupported or empty value", () => {
    expect(resolveLocale("klingon")).toBe("en");
    expect(resolveLocale("")).toBe("en");
  });
});
