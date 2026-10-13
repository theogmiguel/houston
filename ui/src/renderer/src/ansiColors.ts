export const GHOSTTY_ANSI_COLOR_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
] as const;

export type GhosttyAnsiColorName = (typeof GHOSTTY_ANSI_COLOR_NAMES)[number];
