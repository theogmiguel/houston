import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";

import { clientSpeechSettingsAreDefault, planLegacySpeechImport } from "./legacySpeechImport";

const legacy = {
  speechLanguage: "pt",
  speechTranslateToEnglish: true,
  speechCustomWords: [{ term: "Houston", aliases: ["hust in"] }],
  speechRemoveFillerWords: false,
  speechCorrectionWord: "sorry",
  speechPostProcessingEnabled: true,
  speechPostProcessingPrompt: { mode: "custom", customInstructions: "Keep it short." },
} as const;

it("copies the legacy dictation values into untouched client settings", () => {
  expect(planLegacySpeechImport(DEFAULT_CLIENT_SETTINGS, legacy)).toEqual({
    speechLanguage: "pt",
    speechTranslateToEnglish: true,
    speechCustomWords: legacy.speechCustomWords,
    speechRemoveFillerWords: false,
    speechCorrectionWord: "sorry",
    speechPostProcessingPrompt: { mode: "custom", customInstructions: "Keep it short." },
  });
});

it("never imports the server's cleanup flag as this device's consent", () => {
  const patch = planLegacySpeechImport(DEFAULT_CLIENT_SETTINGS, legacy);
  expect(patch).not.toHaveProperty("speechPostProcessingEnabled");
});

it("leaves client settings the person already changed alone", () => {
  const touched = { ...DEFAULT_CLIENT_SETTINGS, speechLanguage: "de" as const };
  expect(clientSpeechSettingsAreDefault(touched)).toBe(false);
  expect(planLegacySpeechImport(touched, legacy)).toBeNull();
});

it("imports nothing when the primary environment holds no legacy values or only defaults", () => {
  expect(planLegacySpeechImport(DEFAULT_CLIENT_SETTINGS, undefined)).toBeNull();
  expect(planLegacySpeechImport(DEFAULT_CLIENT_SETTINGS, { speechLanguage: "auto" })).toBeNull();
});
