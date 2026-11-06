const UNIVERSAL_FILLER_WORDS = [
  "uh",
  "uhm",
  "umm",
  "uhh",
  "uhhh",
  "ehh",
  "ehm",
  "ahm",
  "hmm",
  "hm",
  "mmm",
  "хм",
  "ммм",
] as const;

// Pure hesitation sounds only. Words that are also vocabulary stay out: "um" and "é" in
// Portuguese, "este" and "bueno" in Spanish, "ha" (laughter) in English.
const LANGUAGE_FILLER_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ["um", "ah", "eh"],
  de: ["äh", "ähm"],
  fr: ["euh"],
  pt: ["ahn", "hã", "ãh", "hum", "eh"],
  es: ["eh", "em", "mm"],
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Without a language, only the language-neutral hesitations in `UNIVERSAL_FILLER_WORDS` apply. */
export function removeSpeechFillerWords(
  text: string,
  language?: string,
  protectedWord?: string,
): string {
  const baseLanguage = language?.split(/[-_]/, 1)[0]?.toLowerCase();
  const words = [
    ...UNIVERSAL_FILLER_WORDS,
    ...(baseLanguage ? (LANGUAGE_FILLER_WORDS[baseLanguage] ?? []) : []),
  ];
  let filtered = text;
  for (const word of words) {
    if (word.toLocaleLowerCase() === protectedWord?.trim().toLocaleLowerCase()) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegex(word)}(?![\\p{L}\\p{N}_])[,.]?`,
      "giu",
    );
    filtered = filtered.replace(pattern, "");
  }
  return filtered.replace(/\s{2,}/g, " ").trim();
}
