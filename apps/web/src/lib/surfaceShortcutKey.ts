const SURFACE_SHORTCUT_KEY_PATTERN = /^[a-z0-9]$/i;
const PHYSICAL_PATTERN = /^[\p{L}\p{M}]+$/u;
const PHYSICAL_PATTERN_2 = /\p{Script=Latin}/u;
const PHYSICAL_PATTERN_3 = /^Key([A-Z])$/;

type SurfaceKeyEvent = Pick<KeyboardEvent, "key"> &
  Partial<Pick<KeyboardEvent, "code" | "getModifierState">>;

export function surfaceShortcutKey(event: SurfaceKeyEvent): string | null {
  // AltGr text must stay text even when the browser omits Ctrl and Alt.
  if (event.getModifierState?.("AltGraph") && !SURFACE_SHORTCUT_KEY_PATTERN.test(event.key))
    return null;
  const typed = event.key.toLowerCase();
  // Preserve Latin layouts, punctuation and dead keys; non-Latin letters/marks use the physical key.
  const physical =
    PHYSICAL_PATTERN.test(typed) && !PHYSICAL_PATTERN_2.test(typed)
      ? event.code?.match(PHYSICAL_PATTERN_3)?.[1]?.toLowerCase()
      : undefined;
  return physical ?? typed;
}
