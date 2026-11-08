/**
 * Moves a scrolled composer input to the nearest whole line, so the topmost visible line starts
 * exactly below the editor's 8px top padding (where the fade sits) and none is cut in half.
 * The editor's height is a whole number of lines plus its vertical padding, so the end of the
 * scroll range is already on a line.
 */
export function snapComposerScroll(editor: HTMLElement): void {
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
  const target = Math.round(editor.scrollTop / lineHeight) * lineHeight;
  if (Math.abs(target - editor.scrollTop) < 0.5) return;
  editor.scrollTop = target;
}
