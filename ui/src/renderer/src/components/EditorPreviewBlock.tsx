import type { EditorPreviewState } from '../editor/previewState'
import { formatMB, formatMBWhole } from '../editor/previewState'
import {
  EPREVIEW_DETAIL_CLS,
  EPREVIEW_NAME_CLS,
  EPREVIEW_TITLE_CLS,
  EPREVIEW_WRAP_CLS
} from '../editor/editorChrome'

export function EditorPreviewBlock({
  state,
  name,
  action,
  testId
}: {
  state: EditorPreviewState
  name?: string
  action?: React.ReactNode
  testId?: string
}): React.JSX.Element {
  switch (state.kind) {
    case 'loading':
      return (
        <div className={EPREVIEW_WRAP_CLS} data-testid={testId ?? 'editor-preview-loading'}>
          <span className={EPREVIEW_TITLE_CLS}>Loading file…</span>
          {action}
        </div>
      )
    case 'too-large':
      return (
        <div className={EPREVIEW_WRAP_CLS} data-testid={testId ?? 'editor-preview-too-large'}>
          <span className={EPREVIEW_TITLE_CLS}>{state.title}</span>
          {name && <span className={EPREVIEW_NAME_CLS}>{name}</span>}
          <span className={EPREVIEW_DETAIL_CLS}>
            {formatMB(state.sizeBytes)} (max {formatMBWhole(state.maxBytes)})
          </span>
          {action}
        </div>
      )
    case 'error':
      return (
        <div className={EPREVIEW_WRAP_CLS} data-testid={testId ?? 'editor-preview-error'}>
          <span className={EPREVIEW_TITLE_CLS}>{state.title}</span>
          {name && <span className={EPREVIEW_NAME_CLS}>{name}</span>}
          <span className={EPREVIEW_DETAIL_CLS}>{state.detail}</span>
          {action}
        </div>
      )
    case 'unsupported':
      return (
        <div className={EPREVIEW_WRAP_CLS} data-testid={testId ?? 'editor-preview-unsupported'}>
          <span className={EPREVIEW_TITLE_CLS}>Unsupported file type</span>
          {name && <span className={EPREVIEW_NAME_CLS}>{name}</span>}
          <span className={EPREVIEW_DETAIL_CLS}>Binary files aren&apos;t previewable yet.</span>
          {action}
        </div>
      )
  }
}
