import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { detectLineEnding } from './buffers'
import { caretLabel, caretPosition, languageLabel, PLAIN_TEXT_LABEL } from './statusStrip'

describe('status strip — language', () => {
  it('names the language from the same table the buffer picks its grammar from', async () => {
    expect(await languageLabel('/ws/src/main.rs')).toBe('Rust')
    expect(await languageLabel('/ws/App.tsx')).toBe('TSX')
    expect(await languageLabel('/ws/README.md')).toBe('Markdown')
  })

  it('falls back to plain text rather than guessing at an unknown extension', async () => {
    expect(await languageLabel('/ws/notes.zzz')).toBe(PLAIN_TEXT_LABEL)
    expect(await languageLabel('/ws/LICENSE')).toBe(PLAIN_TEXT_LABEL)
  })
})

describe('status strip — caret', () => {
  const doc = 'alpha\nbeta\ngamma'

  it('counts lines and columns from 1, as every editor’s status bar does', () => {
    const state = EditorState.create({ doc, selection: { anchor: 0 } })
    expect(caretPosition(state)).toEqual({ line: 1, col: 1 })
    expect(caretLabel(caretPosition(state))).toBe('Ln 1, Col 1')
  })

  it('reports the line the caret is on, not the document offset', () => {
    const state = EditorState.create({ doc, selection: { anchor: 8 } })
    expect(caretPosition(state)).toEqual({ line: 2, col: 3 })
  })

  it('follows the selection’s HEAD, so a drag reports the end being moved', () => {
    const state = EditorState.create({ doc, selection: { anchor: 0, head: 12 } })
    expect(caretPosition(state)).toEqual({ line: 3, col: 2 })
  })
})

describe('status strip — line ending', () => {
  it('reads CRLF from the first line break, and LF from anything else', () => {
    expect(detectLineEnding('a\r\nb')).toBe('CRLF')
    expect(detectLineEnding('a\nb')).toBe('LF')
  })

  it('calls a file with no line break at all LF, not unknown', () => {
    expect(detectLineEnding('one line, no break')).toBe('LF')
    expect(detectLineEnding('')).toBe('LF')
  })

  it('answers from the FIRST break, so mixed endings get a deterministic answer', () => {
    expect(detectLineEnding('a\r\nb\nc')).toBe('CRLF')
    expect(detectLineEnding('a\nb\r\nc')).toBe('LF')
  })

  it('does not mistake a leading newline for a CRLF', () => {
    expect(detectLineEnding('\nabc')).toBe('LF')
  })
})
