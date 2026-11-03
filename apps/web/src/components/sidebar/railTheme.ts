import type { ThemePreferenceMode } from "../../themePalette";

export type RailThemeMode = ThemePreferenceMode;

const THEME_LABELS: Record<RailThemeMode, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

/** The rail's Theme button cycles System → Dark → Light using the stored appearance mode. */
export function nextRailThemeMode(mode: RailThemeMode): RailThemeMode {
  if (mode === "system") return "dark";
  if (mode === "dark") return "light";
  return "system";
}

export function railThemeLabel(mode: RailThemeMode): string {
  return THEME_LABELS[mode];
}
