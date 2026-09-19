export type EditorPreviewState =
  | { kind: 'loading' }
  | { kind: 'too-large'; sizeBytes: number; maxBytes: number; title: string }
  | {
      kind: 'error'
      title: 'Unsupported encoding' | 'Could not read file' | 'Preview unavailable'
      detail: string
    }
  | { kind: 'unsupported' }

const TOO_LARGE_EDIT_RE = /^file too large to edit: .+ is (\d+) bytes \(max (\d+)\)$/
const TOO_LARGE_PREVIEW_RE = /^file too large to preview: .+ is (\d+) bytes \(max (\d+)\)$/
const BINARY_RE = /^refusing to open binary file: /
const UTF8_RE = /^file .+ is not valid UTF-8 text: /

export function classifyReadError(message: string): EditorPreviewState {
  const tooLargeToEdit = TOO_LARGE_EDIT_RE.exec(message)
  if (tooLargeToEdit) {
    return {
      kind: 'too-large',
      sizeBytes: Number(tooLargeToEdit[1]),
      maxBytes: Number(tooLargeToEdit[2]),
      title: 'File too large to edit'
    }
  }
  const tooLargeToPreview = TOO_LARGE_PREVIEW_RE.exec(message)
  if (tooLargeToPreview) {
    return {
      kind: 'too-large',
      sizeBytes: Number(tooLargeToPreview[1]),
      maxBytes: Number(tooLargeToPreview[2]),
      title: 'File too large to preview'
    }
  }
  if (BINARY_RE.test(message)) return { kind: 'unsupported' }
  if (UTF8_RE.test(message)) return { kind: 'error', title: 'Unsupported encoding', detail: message }
  return { kind: 'error', title: 'Could not read file', detail: message }
}

export function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatMBWhole(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}
