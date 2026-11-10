import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
  type LegacySpeechSettings,
} from "@houston-app/contracts";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";
import {
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import { usePrimarySettings } from "../hooks/useSettings";

/** Marks this device as having had its one chance to adopt the dictation values servers used to hold. */
export const LEGACY_SPEECH_IMPORT_KEY = "houston:voice-legacy-import:v1";
const ImportMarker = Schema.Boolean;

const IMPORTED_KEYS = [
  "speechLanguage",
  "speechTranslateToEnglish",
  "speechCustomWords",
  "speechRemoveFillerWords",
  "speechCorrectionWord",
  "speechPostProcessingPrompt",
] as const satisfies ReadonlyArray<keyof ClientSettings>;

/** True while every imported key still holds its default, so nothing the person chose can be lost. */
export function clientSpeechSettingsAreDefault(client: ClientSettings): boolean {
  return IMPORTED_KEYS.every((key) => Equal.equals(client[key], DEFAULT_CLIENT_SETTINGS[key]));
}

/**
 * The client settings to adopt from the primary environment's legacy values, or null when there
 * is nothing to adopt. Cleanup consent (`speechPostProcessingEnabled`) is never imported: a
 * server-side flag is not this device's consent.
 */
export function planLegacySpeechImport(
  client: ClientSettings,
  legacy: LegacySpeechSettings | undefined,
): ClientSettingsPatch | null {
  if (!legacy || !clientSpeechSettingsAreDefault(client)) return null;
  const patch: ClientSettingsPatch = {
    ...(legacy.speechLanguage !== undefined ? { speechLanguage: legacy.speechLanguage } : {}),
    ...(legacy.speechTranslateToEnglish !== undefined
      ? { speechTranslateToEnglish: legacy.speechTranslateToEnglish }
      : {}),
    ...(legacy.speechCustomWords !== undefined
      ? { speechCustomWords: legacy.speechCustomWords }
      : {}),
    ...(legacy.speechRemoveFillerWords !== undefined
      ? { speechRemoveFillerWords: legacy.speechRemoveFillerWords }
      : {}),
    ...(legacy.speechCorrectionWord !== undefined
      ? { speechCorrectionWord: legacy.speechCorrectionWord }
      : {}),
    ...(legacy.speechPostProcessingPrompt
      ? {
          speechPostProcessingPrompt: {
            mode: legacy.speechPostProcessingPrompt.mode ?? ("default" as const),
            customInstructions: legacy.speechPostProcessingPrompt.customInstructions ?? "",
          },
        }
      : {}),
  };
  const changed = Object.keys(patch).filter((key) => {
    const name = key as (typeof IMPORTED_KEYS)[number];
    return !Equal.equals(patch[name], DEFAULT_CLIENT_SETTINGS[name]);
  });
  return changed.length === 0 ? null : patch;
}

/**
 * Runs the one-time import on this device. It waits for the primary environment's settings to
 * report legacy values, and records completion only once it has imported or the device's own
 * values make an import unsafe.
 */
export function useLegacySpeechImport() {
  const hydrated = useClientSettingsHydrated();
  const client = useClientSettings();
  const legacy = usePrimarySettings((settings) => settings.legacySpeech);
  const [done] = useLocalStorage(LEGACY_SPEECH_IMPORT_KEY, false, ImportMarker);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Applies the one-time import when the external primary settings and device settings are both ready.
  useEffect(() => {
    if (!hydrated || done) return;
    // Another mounted editor may have finished first.
    if (readLocalStorageValue(LEGACY_SPEECH_IMPORT_KEY, false, ImportMarker)) return;
    if (!clientSpeechSettingsAreDefault(client)) {
      writeLocalStorageValue(LEGACY_SPEECH_IMPORT_KEY, true, false, ImportMarker);
      return;
    }
    const patch = planLegacySpeechImport(client, legacy);
    if (!patch) return;
    writeLocalStorageValue(LEGACY_SPEECH_IMPORT_KEY, true, false, ImportMarker);
    void updateClientSettings(patch);
  }, [client, done, hydrated, legacy]);
}
