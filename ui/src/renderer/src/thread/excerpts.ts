import { THREAD_EXCERPTS_MAX, THREAD_EXCERPT_MAX_BYTES, THREAD_USER_MESSAGE_MAX_BYTES } from '../houston/generated/DEFAULTS'
import type { ThreadExcerpt } from './threadTypes'

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Rust's `char::is_control`: the C0 and C1 control ranges. */
function isControl(c: string): boolean {
  const code = c.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

export function lineCount(text: string): number {
  const trimmed = text.replace(/[\r\n]+$/, '')
  return trimmed === '' ? 0 : trimmed.split(/\r?\n/).length
}

/** The chip's label: the pane's name and how many lines it quotes; a selection has no line numbers. */
export function excerptLabel(excerpt: ThreadExcerpt): string {
  const lines = lineCount(excerpt.text)
  return `${excerpt.source} · ${lines} ${lines === 1 ? 'line' : 'lines'}`
}

/** The daemon's `compose_message`, so the composer can refuse a message Claude would not get. */
export function composeMessage(text: string, excerpts: readonly ThreadExcerpt[]): string {
  let out = ''
  for (const excerpt of excerpts) {
    let longest = 0
    for (const run of excerpt.text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
    const fence = '`'.repeat(Math.max(3, longest + 1))
    const source = [...excerpt.source].map((c) => (c === '"' || isControl(c) ? ' ' : c)).join('').trim()
    out += `Terminal selection from pane "${source}":\n${fence}\n${excerpt.text.replace(/[\r\n]+$/, '')}\n${fence}\n\n`
  }
  return out + text
}

/** Why the selection cannot be quoted as one more excerpt, or null. */
export function quoteRefusal(excerpts: readonly ThreadExcerpt[], text: string): string | null {
  if (excerpts.length >= THREAD_EXCERPTS_MAX) return `A message quotes at most ${THREAD_EXCERPTS_MAX} selections; remove one first.`
  const size = utf8Length(text)
  if (size > THREAD_EXCERPT_MAX_BYTES) return `This selection is ${size.toLocaleString()} bytes and a quoted selection is limited to ${THREAD_EXCERPT_MAX_BYTES.toLocaleString()} bytes; select less.`
  return null
}

/** Why the message with its excerpts is too large for Claude, or null. */
export function composedRefusal(text: string, excerpts: readonly ThreadExcerpt[]): string | null {
  const size = utf8Length(composeMessage(text, excerpts))
  if (size <= THREAD_USER_MESSAGE_MAX_BYTES) return null
  const what = excerpts.length > 0 ? 'with its quoted selections ' : ''
  return `Message not sent: ${what}it is ${size.toLocaleString()} bytes and a thread message is limited to ${THREAD_USER_MESSAGE_MAX_BYTES.toLocaleString()} bytes.`
}
