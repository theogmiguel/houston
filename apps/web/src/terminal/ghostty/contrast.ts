import type { GhosttyColor } from "./core";

/** WCAG AA for body text. Pale truecolor prompts (pastel on white) fall below it. */
export const TERMINAL_MINIMUM_CONTRAST = 4.5;

function channelLuminance(value: number): number {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(color: GhosttyColor): number {
  return (
    0.2126 * channelLuminance(color.r) +
    0.7152 * channelLuminance(color.g) +
    0.0722 * channelLuminance(color.b)
  );
}

export function contrastRatio(left: GhosttyColor, right: GhosttyColor): number {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

function mix(color: GhosttyColor, target: number, amount: number): GhosttyColor {
  const channel = (value: number) => Math.round(value + (target - value) * amount);
  return { r: channel(color.r), g: channel(color.g), b: channel(color.b) };
}

/**
 * The text colour moved toward black or white, whichever the background contrasts with more,
 * until it reaches `TERMINAL_MINIMUM_CONTRAST`; its hue is kept. A colour that already meets the
 * ratio is returned unchanged.
 */
export function ensureTextContrast(
  foreground: GhosttyColor,
  background: GhosttyColor,
): GhosttyColor {
  if (contrastRatio(foreground, background) >= TERMINAL_MINIMUM_CONTRAST) return foreground;
  const target = luminance(background) > 0.18 ? 0 : 255;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(foreground, target, step / 20);
    if (contrastRatio(candidate, background) >= TERMINAL_MINIMUM_CONTRAST) return candidate;
  }
  return mix(foreground, target, 1);
}

const textColorCache = new Map<number, GhosttyColor>();
// A screen repeats a few hundred colour pairs; the cap only bounds a pathological stream.
const TEXT_COLOR_CACHE_LIMIT = 4096;

/** `ensureTextContrast` memoised for the renderer, which asks once per cell per frame. */
export function legibleTextColor(foreground: GhosttyColor, background: GhosttyColor): GhosttyColor {
  const key =
    ((foreground.r << 16) | (foreground.g << 8) | foreground.b) * 16777216 +
    ((background.r << 16) | (background.g << 8) | background.b);
  const cached = textColorCache.get(key);
  if (cached !== undefined) return cached;
  const color = ensureTextContrast(foreground, background);
  if (textColorCache.size >= TEXT_COLOR_CACHE_LIMIT) textColorCache.clear();
  textColorCache.set(key, color);
  return color;
}
