import { useEffect, useRef, useState } from 'react'
import { basename } from '../editor/bufferStore'
import { readMediaFile, openMediaFile } from '../houston/bridge'
import { classifyReadError, type EditorPreviewState } from '../editor/previewState'
import { mimeForPath } from '../editor/mediaKind'
import {
  EMEDIA_AUDIO_CLS,
  EMEDIA_AUDIO_WRAP_CLS,
  EMEDIA_IMG_CLS,
  EMEDIA_VIDEO_CLS,
  EMEDIA_WRAP_CLS,
  EPREVIEW_DETAIL_CLS,
  EPREVIEW_NAME_CLS,
  EPREVIEW_TITLE_CLS
} from '../editor/editorChrome'
import { EditorPreviewBlock } from './EditorPreviewBlock'
import { BTN_GHOST } from './buttonChrome'

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
      <button
        className={`btn ${BTN_GHOST}`}
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
      </button>
      {openError && (
        <span className={EPREVIEW_DETAIL_CLS} data-testid="editor-preview-open-failed">
          Couldn&apos;t open {basename(filePath)} externally: {openError}
        </span>
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
      <div className={EMEDIA_WRAP_CLS} data-testid={`editor-preview-media-loading`}>
        <span className={EPREVIEW_TITLE_CLS}>Loading {kindLabel}…</span>
      </div>
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
    <div className={EMEDIA_WRAP_CLS} data-testid={`editor-preview-${testId}`}>
      {children(state.url, () => fail(decodeFailureState(kindLabel)))}
    </div>
  )
}

export function ImagePreview({ filePath }: { filePath: string }): React.JSX.Element {
  return (
    <MediaPreviewShell filePath={filePath} kindLabel="image" testId="image">
      {(url, onError) => (
        <img src={url} alt={basename(filePath)} className={EMEDIA_IMG_CLS} onError={onError} />
      )}
    </MediaPreviewShell>
  )
}

export function VideoPreview({ filePath }: { filePath: string }): React.JSX.Element {
  return (
    <MediaPreviewShell filePath={filePath} kindLabel="video" testId="video">
      {(url, onError) => (
        <video
          key={filePath}
          src={url}
          controls
          className={EMEDIA_VIDEO_CLS}
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
        <div className={EMEDIA_AUDIO_WRAP_CLS}>
          <span className={EPREVIEW_NAME_CLS}>{basename(filePath)}</span>
          <audio
            key={filePath}
            src={url}
            controls
            className={EMEDIA_AUDIO_CLS}
            onError={onError}
          />
        </div>
      )}
    </MediaPreviewShell>
  )
}
