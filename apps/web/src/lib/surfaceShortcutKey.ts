type SurfaceKeyEvent = Pick<KeyboardEvent, "key"> &
  Partial<Pick<KeyboardEvent, "code" | "getModifierState">>;

const SURFACE_SHORTCUT_KEY_PATTERN = /^[a-z0-9]$/i;
const LETTER_KEY = /^[\p{L}\p{M}]+$/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;
const KEY_CODE_LETTER = /^Key([A-Z])$/;

export function surfaceShortcutKey(event: SurfaceKeyEvent): string | null {
  // AltGr text must stay text even when the browser omits Ctrl and Alt.
  if (event.getModifierState?.("AltGraph") && !SURFACE_SHORTCUT_KEY_PATTERN.test(event.key))
    return null;
  const typed = event.key.toLowerCase();
  // Preserve Latin layouts, punctuation and dead keys; non-Latin letters/marks use the physical key.
  const physical =
    LETTER_KEY.test(typed) && !LATIN_SCRIPT.test(typed)
      ? event.code?.match(KEY_CODE_LETTER)?.[1]?.toLowerCase()
      : undefined;
  return physical ?? typed;
}
