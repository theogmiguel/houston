import type { AppearanceContrast } from "@houston-app/contracts/settings";

export function applyAppearanceContrast(root: HTMLElement, contrast: AppearanceContrast): void {
  root.style.setProperty("--appearance-contrast-base", `${Math.min(contrast, 100)}%`);
  root.style.setProperty("--appearance-contrast-boost", `${Math.max(contrast - 100, 0)}%`);
  root.style.setProperty(
    "--appearance-contrast-border-boost",
    `${Math.max(contrast - 100, 0) / 4}%`,
  );
}

/** The slider's own value as a percentage, so the label reads the same scale as the thumb. */
export function formatAppearanceContrast(contrast: AppearanceContrast): string {
  return `${contrast}%`;
}
