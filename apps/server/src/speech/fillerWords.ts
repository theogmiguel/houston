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

const REGEX_SPECIAL_CHARACTER = /[.*+?^${}()|[\]\\]/g;

const escapeRegex = (value: string) => value.replace(REGEX_SPECIAL_CHARACTER, "\\$&");

const BASE_LANGUAGE_PATTERN = /[-_]/;
const WHITESPACE_RUN = /\s+/;
const REMOVE_SPEECH_FILLER_WORDS_PATTERN = /\s{2,}/g;

/**
 * Without a language, only the language-neutral hesitations in `UNIVERSAL_FILLER_WORDS` apply.
 * A correction cue, which may span several words, is left in place even when it is a filler.
 */
export function removeSpeechFillerWords(
  text: string,
  language?: string,
  correctionCue?: string,
): string {
  const baseLanguage = language?.split(BASE_LANGUAGE_PATTERN, 1)[0]?.toLowerCase();
  const words = [
    ...UNIVERSAL_FILLER_WORDS,
    ...(baseLanguage ? (LANGUAGE_FILLER_WORDS[baseLanguage] ?? []) : []),
  ];
  const cuePattern = correctionCue?.trim().split(WHITESPACE_RUN).map(escapeRegex).join("\\s+");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:(${cuePattern || "(?!)"})(?![\\p{L}\\p{N}_])|(?:${words.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}_])[,.]?)`,
    "giu",
  );
  const filtered = text.replace(pattern, (_match, cue: string | undefined) => cue ?? "");
  return filtered.replace(REMOVE_SPEECH_FILLER_WORDS_PATTERN, " ").trim();
}
