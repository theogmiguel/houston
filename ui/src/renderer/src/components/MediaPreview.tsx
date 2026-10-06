import { useEffect, useRef, useState } from 'react'
import { basename } from '../editor/bufferStore'
import { readMediaFile, openMediaFile } from '../houston/bridge'
import { classifyReadError, type EditorPreviewState } from '../editor/previewState'
import { mimeForPath } from '../editor/mediaKind'
import { MediaPreviewAudio, MediaPreviewAudioGroup, MediaPreviewImage, MediaPreviewSurface, MediaPreviewVideo, PreviewDetail, PreviewName, PreviewTitle } from './ui/EditorPreview'
import { Button } from './ui/Button'
import { EditorPreviewBlock } from './EditorPreviewBlock'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; state: EditorPreviewState }

function useMediaObjectUrl(filePath: string): [LoadState, (state: EditorPreviewState) => void] {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      try {
        const bytes = await readMediaFile(filePath)
        if (cancelled) return
        const blob = new Blob([bytes], { type: mimeForPath(filePath) })
        const url = URL.createObjectURL(blob)
        urlRef.current = url
        setState({ status: 'ready', url })
      } catch (e) {
        if (cancelled) return
        setState({
          status: 'error',
          state: classifyReadError(e instanceof Error ? e.message : String(e))
        })
      }
    })()
    return () => {
      cancelled = true
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [filePath])

  return [state, (next: EditorPreviewState) => setState({ status: 'error', state: next })]
}

function decodeFailureState(kindLabel: string): EditorPreviewState {
  return {
    kind: 'error',
    title: 'Preview unavailable',
    detail: `The bytes loaded, but this ${kindLabel} could not be decoded here — the format or codec may not be supported by the app's renderer. Open it externally to view it.`
  }
}

function OpenExternallyAction({ filePath }: { filePath: string }): React.JSX.Element {
  const [openError, setOpenError] = useState<string | null>(null)
  return (
    <>
      <Button
        variant="legacy-ghost"
        data-testid="editor-preview-open-externally"
        onClick={() => {
          setOpenError(null)
          void openMediaFile(filePath).then(
            (res) => {
              if (!res.ok) {
                setOpenError(res.error || 'the system handler reported no reason')
              }
            },
            (e: unknown) => setOpenError(e instanceof Error ? e.message : String(e))
          )
        }}
      >
        Open externally
      </Button>
      {openError && (
        <PreviewDetail data-testid="editor-preview-open-failed">
          Couldn&apos;t open {basename(filePath)} externally: {openError}
        </PreviewDetail>
      )}
    </>
  )
}

function MediaPreviewShell({
  filePath,
  kindLabel,
  testId,
  children
}: {
  filePath: string
  kindLabel: string
  testId: string
  children: (url: string, onError: () => void) => React.ReactNode
}): React.JSX.Element {
  const [state, fail] = useMediaObjectUrl(filePath)

  if (state.status === 'loading') {
    return (
      <MediaPreviewSurface data-testid="editor-preview-media-loading">
        <PreviewTitle>Loading {kindLabel}…</PreviewTitle>
      </MediaPreviewSurface>
    )
  }
  if (state.status === 'error') {
    return (
      <EditorPreviewBlock
        state={state.state}
        name={basename(filePath)}
        testId="editor-preview-media-unavailable"
        action={<OpenExternallyAction filePath={filePath} />}
      />
    )
  }
  return (
    <MediaPreviewSurface data-testid={`editor-preview-${testId}`}>
      {children(state.url, () => fail(decodeFailureState(kindLabel)))}
    </MediaPreviewSurface>
  )
}

export function ImagePreview({ filePath }: { filePath: string }): React.JSX.Element {
  return (
    <MediaPreviewShell filePath={filePath} kindLabel="image" testId="image">
      {(url, onError) => (
        <MediaPreviewImage src={url} alt={basename(filePath)} onError={onError} />
      )}
    </MediaPreviewShell>
  )
}

export function VideoPreview({ filePath }: { filePath: string }): React.JSX.Element {
  return (
    <MediaPreviewShell filePath={filePath} kindLabel="video" testId="video">
      {(url, onError) => (
        <MediaPreviewVideo
          key={filePath}
          src={url}
          controls
          onError={onError}
        />
      )}
    </MediaPreviewShell>
  )
}

export function AudioPreview({ filePath }: { filePath: string }): React.JSX.Element {
  return (
    <MediaPreviewShell filePath={filePath} kindLabel="audio" testId="audio">
      {(url, onError) => (
        <MediaPreviewAudioGroup>
          <PreviewName>{basename(filePath)}</PreviewName>
          <MediaPreviewAudio
            key={filePath}
            src={url}
            controls
            onError={onError}
          />
        </MediaPreviewAudioGroup>
      )}
    </MediaPreviewShell>
  )
}
