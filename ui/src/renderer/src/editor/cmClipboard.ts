import type { EditorView as CmView } from '@codemirror/view'

export interface ClipboardFailure {
  onError: (message: string) => void
}

export function cmCopySelection(view: CmView, { onError }: ClipboardFailure): void {
  const { from, to } = view.state.selection.main
  if (from === to) return
  navigator.clipboard
    .writeText(view.state.sliceDoc(from, to))
    .then(undefined, () => onError('Copy failed — clipboard access was denied'))
}

export function cmCutSelection(view: CmView, { onError }: ClipboardFailure): void {
  if (view.state.readOnly) return
  const { from, to } = view.state.selection.main
  if (from === to) return
  navigator.clipboard.writeText(view.state.sliceDoc(from, to)).then(
    () => view.dispatch({ changes: { from, to, insert: '' } }),
    () => onError('Cut failed — clipboard access was denied, nothing was deleted')
  )
}

export function cmPasteClipboard(
  view: CmView,
  { onError, isStale }: ClipboardFailure & {
    isStale: () => boolean
  }
): void {
  if (view.state.readOnly) return
  navigator.clipboard.readText().then(
    (text) => {
      if (isStale()) return
      view.dispatch(view.state.replaceSelection(text))
      view.focus()
    },
    () => onError('Paste failed — clipboard access was denied')
  )
}
