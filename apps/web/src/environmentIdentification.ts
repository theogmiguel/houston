import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentIdentificationMode } from "@houston-app/contracts";

import { APP_STAGE_LABEL } from "./branding";
import { resolveServerBackedAppStageLabel } from "./branding.logic";
import { primaryServerConfigAtom } from "./state/server";

export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

/** Stored artwork modes predate the pill-only display and show as the pill. */
export function resolveEnvironmentIdentificationDisplay(
  mode: EnvironmentIdentificationMode,
  settingsHydrated: boolean,
): "pill" | "none" {
  return settingsHydrated && mode !== "none" ? "pill" : "none";
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}
