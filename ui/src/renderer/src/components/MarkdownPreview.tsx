import { useEffect, useRef, useState } from 'react'
import { IconEye, IconPencil } from './icons'
import { Tooltip } from './ui/Tooltip'
import { MarkdownPreviewPage, MarkdownPreviewViewport, PreviewDetail, PreviewStatus, PreviewTitle } from './ui/EditorPreview'
import { Icon } from './ui/Icon'
import { MarkdownToggle } from './ui/MarkdownToggle'
import { Text } from './ui/Text'

export type MarkdownMode = 'preview' | 'edit'

export const MARKDOWN_DEFAULT_MODE: MarkdownMode = 'preview'
const MD_TOGGLE_COPY = { preview: { action: 'Edit source', label: 'Edit' }, edit: { action: 'Preview', label: 'Preview' } } as const

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
  className,
  size = 'inline'
}: {
  mode: MarkdownMode
  onToggle: () => void
  className?: string
  size?: 'inline' | 'mini'
}): React.JSX.Element {
  const copy = MD_TOGGLE_COPY[mode]
  return (
    <Tooltip label={copy.action}>
      <MarkdownToggle
        size={size}
        className={className}
        data-testid="editor-markdown-toggle"
        aria-label={copy.action}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        {mode === 'preview' ? <Icon glyph={IconPencil} role="label" /> : <Icon glyph={IconEye} role="label" />}
        <Text as="span" size="label" weight="label" caps>{copy.label}</Text>
      </MarkdownToggle>
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
    <MarkdownPreviewViewport
      enabled={!chat}
      data-testid={chat ? 'chat-preview-markdown' : 'editor-preview-markdown'}
    >
      {error ? (
        <PreviewStatus
          chat={chat}
          data-testid="editor-markdown-load-error"
        >
          <PreviewTitle as="div">Could not load the markdown preview</PreviewTitle>
          <PreviewDetail as="div" data-testid="editor-markdown-load-error-detail">
            {error instanceof Error ? error.message : String(error)}
          </PreviewDetail>
          <MarkdownToggle
            size="control"
            data-testid="editor-markdown-retry"
            onClick={() => setAttempt((n) => n + 1)}
          >
            <Text as="span" size="label" weight="label" caps>Retry</Text>
          </MarkdownToggle>
        </PreviewStatus>
      ) : !mod ? (
        <PreviewStatus
          chat={chat}
          data-testid="editor-markdown-loading"
        >
          <PreviewDetail as="div">Loading preview…</PreviewDetail>
        </PreviewStatus>
      ) : (
        <MarkdownPreviewPage enabled={!chat}>
          <mod.MarkdownDocument source={source} variant={variant} />
        </MarkdownPreviewPage>
      )}
    </MarkdownPreviewViewport>
  )
}
