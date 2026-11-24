import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type LocalAgentSuggestion,
  type ServerSettings,
} from "@houston-app/contracts";
import { resolveCommandPath } from "@houston-app/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Settings from "../serverSettings.ts";

export interface LocalAgentDetector {
  readonly driver: ProviderDriverKind;
  readonly found: Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>;
}

const commandOnPath = (command: string) =>
  resolveCommandPath(command).pipe(
    Effect.map((resolved) => resolved !== null),
    Effect.orElseSucceed(() => false),
  );

/** Agents that run local models, and how to tell one is on this machine. */
export const LOCAL_AGENT_DETECTORS: ReadonlyArray<LocalAgentDetector> = [
  { driver: ProviderDriverKind.make("pi"), found: commandOnPath("pi") },
  { driver: ProviderDriverKind.make("opencode"), found: commandOnPath("opencode") },
];

type Suggestions = Readonly<Record<string, LocalAgentSuggestion>>;

/** The patch that leaves each agent with the suggestion its detection and history call for. */
function suggestionPatch(
  settings: Pick<ServerSettings, "providerInstances" | "localAgentSuggestions">,
  detectors: ReadonlyArray<LocalAgentDetector>,
  found: ReadonlyMap<string, boolean>,
  foundAt: string,
): Record<string, LocalAgentSuggestion | null> {
  const patch: Record<string, LocalAgentSuggestion | null> = {};
  const current: Suggestions = settings.localAgentSuggestions;
  for (const { driver } of detectors) {
    const existing = current[driver];
    const configured = defaultInstanceIdForDriver(driver) in settings.providerInstances;
    if (configured) {
      if (existing?.status !== "enabled") {
        patch[driver] = { driver, status: "enabled", foundAt };
      }
      continue;
    }
    if (found.get(driver) !== true) {
      if (existing?.status === "suggested") patch[driver] = null;
      continue;
    }
    if (existing === undefined) patch[driver] = { driver, status: "suggested", foundAt };
  }
  return patch;
}

/**
 * Records a suggestion for each local agent found on this machine that was never configured or
 * dismissed. Detection runs at startup and never turns an agent on by itself; Settings offers
 * the suggestion and remembers the user's answer.
 */
export const seedLocalAgentSuggestions = Effect.fn("Houston.providerSuggestions.seed")(function* (
  detectors: ReadonlyArray<LocalAgentDetector> = LOCAL_AGENT_DETECTORS,
) {
  const serverSettings = yield* Settings.ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const found = new Map<string, boolean>();
  for (const detector of detectors) {
    found.set(detector.driver, yield* detector.found);
  }
  const patch = suggestionPatch(
    settings,
    detectors,
    found,
    DateTime.formatIso(yield* DateTime.now),
  );
  if (Object.keys(patch).length === 0) return;
  yield* serverSettings.updateSettings({ localAgentSuggestions: patch });
});
