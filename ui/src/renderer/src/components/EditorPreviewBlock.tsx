import type { EditorPreviewState } from '../editor/previewState'
import { formatLargeFileNotice } from '../editor/previewState'
import { PreviewDetail, PreviewName, PreviewState, PreviewTitle } from './ui/EditorPreview'
import { Notice } from './ui'

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
        <PreviewState data-testid={testId ?? 'editor-preview-loading'}>
          <PreviewTitle>Loading file…</PreviewTitle>
          {action}
        </PreviewState>
      )
    case 'too-large':
      return (
        <PreviewState data-testid={testId ?? 'editor-preview-too-large'}>
          <PreviewTitle>{state.title}</PreviewTitle>
          {name && <PreviewName>{name}</PreviewName>}
          <Notice tone="info" className="w-full">
            {formatLargeFileNotice(state.sizeBytes, state.maxBytes, state.title.endsWith('edit') ? 'edit' : 'preview')}
          </Notice>
          {action}
        </PreviewState>
      )
    case 'error':
      return (
        <PreviewState data-testid={testId ?? 'editor-preview-error'}>
          <PreviewTitle>{state.title}</PreviewTitle>
          {name && <PreviewName>{name}</PreviewName>}
          <PreviewDetail>{state.detail}</PreviewDetail>
          {action}
        </PreviewState>
      )
    case 'unsupported':
      return (
        <PreviewState data-testid={testId ?? 'editor-preview-unsupported'}>
          <PreviewTitle>Unsupported file type</PreviewTitle>
          {name && <PreviewName>{name}</PreviewName>}
          <PreviewDetail>Binary files aren&apos;t previewable yet.</PreviewDetail>
          {action}
        </PreviewState>
      )
  }
}
