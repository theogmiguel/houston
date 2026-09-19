import type { EditorState } from '@codemirror/state'
import { basename } from './bufferStore'

export const PLAIN_TEXT_LABEL = 'Plain Text'

export async function languageLabel(path: string): Promise<string> {
  const [{ LanguageDescription }, { languages }] = await Promise.all([
    import('@codemirror/language'),
    import('@codemirror/language-data')
  ])
  return LanguageDescription.matchFilename(languages, basename(path))?.name ?? PLAIN_TEXT_LABEL
}

export interface CaretPosition {
  line: number
  col: number
}

export function caretPosition(state: EditorState): CaretPosition {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { line: line.number, col: head - line.from + 1 }
}

export function caretLabel(pos: CaretPosition): string {
  return `Ln ${pos.line}, Col ${pos.col}`
}
