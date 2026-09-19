import { useEffect, useRef, useState } from 'react'
import { IconEye, IconPencil } from './icons'
import { Tooltip } from './Tooltip'
import {
  EMD_PAGE_CLS,
  EMD_TOGGLE_CLS,
  EMD_WRAP_CLS,
  EPREVIEW_DETAIL_CLS,
  EPREVIEW_TITLE_CLS,
  EPREVIEW_WRAP_CLS,
  MD_TOGGLE_COPY
} from '../editor/editorChrome'
import { Icon } from './Icon'

const CHAT_STATUS_WRAP_CLS = 'flex flex-col items-start gap-1.5 text-left'

export type MarkdownMode = 'preview' | 'edit'

export const MARKDOWN_DEFAULT_MODE: MarkdownMode = 'preview'

type PipelineModule = typeof import('./markdownPipeline')

let pipeline: Promise<PipelineModule> | null = null

export function loadMarkdownPipeline(): Promise<PipelineModule> {
  pipeline ??= import('./markdownPipeline').catch((err: unknown) => {
    pipeline = null
    throw err
  })
  return pipeline
}

export function preloadMarkdownPipeline(): void {
  void loadMarkdownPipeline().catch((err: unknown) => {
    console.warn('houston: markdown preview chunk preload failed', err)
  })
}

export function resetMarkdownPipelineForTest(): void {
  pipeline = null
}

export function MarkdownPreviewToggle({
  mode,
  onToggle,
  className
}: {
  mode: MarkdownMode
  onToggle: () => void
  className?: string
}): React.JSX.Element {
  const copy = MD_TOGGLE_COPY[mode]
  return (
    <Tooltip label={copy.action}>
      <button
        className={className ? `${EMD_TOGGLE_CLS} ${className}` : EMD_TOGGLE_CLS}
        data-testid="editor-markdown-toggle"
        aria-label={copy.action}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        {mode === 'preview' ? <Icon glyph={IconPencil} role="label" /> : <Icon glyph={IconEye} role="label" />}
        {copy.label}
      </button>
    </Tooltip>
  )
}

export function MarkdownPreview({
  source,
  variant = 'editor'
}: {
  source: string
  variant?: 'editor' | 'chat'
}): React.JSX.Element {
  const [mod, setMod] = useState<PipelineModule | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (mod) return
    setError(null)
    loadMarkdownPipeline().then(
      (m) => {
        if (live.current) setMod(m)
      },
      (err: unknown) => {
        console.warn('houston: markdown preview chunk failed to load', err)
        if (live.current) setError(err)
      }
    )
  }, [attempt, mod])

  const chat = variant === 'chat'
  return (
    <div
      className={chat ? '' : EMD_WRAP_CLS}
      data-testid={chat ? 'chat-preview-markdown' : 'editor-preview-markdown'}
    >
      {error ? (
        <div
          className={chat ? CHAT_STATUS_WRAP_CLS : EPREVIEW_WRAP_CLS}
          data-testid="editor-markdown-load-error"
        >
          <div className={EPREVIEW_TITLE_CLS}>Could not load the markdown preview</div>
          <div className={EPREVIEW_DETAIL_CLS} data-testid="editor-markdown-load-error-detail">
            {error instanceof Error ? error.message : String(error)}
          </div>
          <button
            className={`${EMD_TOGGLE_CLS} h-7`}
            data-testid="editor-markdown-retry"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      ) : !mod ? (
        <div
          className={chat ? CHAT_STATUS_WRAP_CLS : EPREVIEW_WRAP_CLS}
          data-testid="editor-markdown-loading"
        >
          <div className={EPREVIEW_DETAIL_CLS}>Loading preview…</div>
        </div>
      ) : (
        <div className={chat ? '' : EMD_PAGE_CLS}>
          <mod.MarkdownDocument source={source} variant={variant} />
        </div>
      )}
    </div>
  )
}
