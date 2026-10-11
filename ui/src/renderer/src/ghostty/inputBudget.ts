// A paste is one atomic PTY write. This allows a large code excerpt while bounding
// text UTF-8 to 192 KiB before paste/framing markers; use files for larger material.
export const MAX_PASTE_CODE_UNITS = 64 * 1024
export function assertPasteBudget(text: string): void {
  if (text.length > MAX_PASTE_CODE_UNITS) throw new Error(
    `Paste refused: requested ${text.length} UTF-16 code units; limit ${MAX_PASTE_CODE_UNITS}; current paste size 0. Use a file for larger content.`)
}
