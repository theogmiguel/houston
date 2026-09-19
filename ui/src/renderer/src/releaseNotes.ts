// A bounded, plain-text teaser of a GitHub release body. The notes are kept
// verbatim (markdown syntax and all) and never rendered as HTML; every cut
// announces itself with an ellipsis.

// Eight lines / 600 chars / 120 a line: enough to read what changed in the
// About column without the Update row scrolling out of sight. A longer body is
// what the release page is for.
export const RELEASE_NOTES_MAX_LINES = 8
export const RELEASE_NOTES_MAX_CHARS = 600
export const RELEASE_NOTES_LINE_MAX_CHARS = 120

function clipLine(line: string): { text: string; clipped: boolean } {
  if (line.length <= RELEASE_NOTES_LINE_MAX_CHARS) return { text: line, clipped: false }
  const cut = line.slice(0, RELEASE_NOTES_LINE_MAX_CHARS)
  // Prefer the last whole word, but not one so early that most of the line is
  // thrown away for a space near its head.
  const space = cut.lastIndexOf(' ')
  return {
    text: space > RELEASE_NOTES_LINE_MAX_CHARS / 2 ? cut.slice(0, space) : cut,
    clipped: true
  }
}

export function summarizeReleaseNotes(notes: string): string | null {
  const lines = notes.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  let chars = 0
  let truncated = false
  for (const raw of lines) {
    const { text, clipped } = clipLine(raw.trimEnd())
    if (clipped) truncated = true
    const next = chars + text.length + (kept.length > 0 ? 1 : 0)
    if (kept.length >= RELEASE_NOTES_MAX_LINES || next > RELEASE_NOTES_MAX_CHARS) {
      truncated = true
      break
    }
    kept.push(text)
    chars = next
  }
  while (kept.length > 0 && kept[0] === '') kept.shift()
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  if (kept.length === 0) return null
  return truncated ? `${kept.join('\n')}\n…` : kept.join('\n')
}
