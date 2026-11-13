// Dependency-free, so code that only names a theme does not load diff parsing or the highlighter.
// readableSyntaxTheme registers the light theme; import it wherever a highlighter resolves one.
export const READABLE_LIGHT_THEME_NAME = "houston-light";

// Light mode uses a darker pierre-light so syntax stays readable on every code surface.
export const DIFF_THEME_NAMES = {
  light: READABLE_LIGHT_THEME_NAME,
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return DIFF_THEME_NAMES[theme];
}
