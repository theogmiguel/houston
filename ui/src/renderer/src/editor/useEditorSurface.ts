import { useEffect, useRef, useState, type RefObject } from 'react'
import type { EditorView as CmView } from '@codemirror/view'
import {
  cleanError,
  getBuffer,
  onReveal,
  retainBuffer,
  subscribeBuffer,
  takePendingReveal,
  type EditorBuffer,
  type RevealRequest
} from './bufferStore'
import { classifyMediaKind, isPreviewBlocked, type MediaKind } from './mediaKind'
import { classifyReadError, type EditorPreviewState } from './previewState'
import { MARKDOWN_DEFAULT_MODE, preloadMarkdownPipeline, type MarkdownMode } from '../components/MarkdownPreview'

export const SAVE_FEEDBACK_MS = 2000

export type SaveState = 'saving' | 'saved'

export interface CmMenuAnchor {
  x: number
  y: number
}

export interface EditorSurfaceState {
  workspaceDir: string
  path: string
  hostRef: RefObject<HTMLDivElement | null>
  viewRef: RefObject<CmView | null>
  viewGenRef: RefObject<number>
  ready: boolean
  buf: EditorBuffer | undefined
  previewState: EditorPreviewState | null
  error: string | null
  setError: (e: string | null) => void
  saveState: SaveState | null
  save: () => void
  mediaKind: MediaKind
  isMediaPreview: boolean
  isMarkdown: boolean
  markdownReady: boolean
  showMarkdownPreview: boolean
  mdMode: MarkdownMode
  toggleMarkdownMode: () => void
  cmMenu: CmMenuAnchor | null
  setCmMenu: (a: CmMenuAnchor | null) => void
}

export function useEditorSurface(workspaceDir: string, path: string): EditorSurfaceState {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CmView | null>(null)
  const viewGenRef = useRef(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewState, setPreviewState] = useState<EditorPreviewState | null>(null)
  const [, bump] = useState(0)
  const [saveState, setSaveState] = useState<SaveState | null>(null)
  const saveStateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saveTokenRef = useRef(0)
  const [cmMenu, setCmMenu] = useState<CmMenuAnchor | null>(null)
  const [mdMode, setMdMode] = useState<MarkdownMode>(MARKDOWN_DEFAULT_MODE)
  useEffect(() => setMdMode(MARKDOWN_DEFAULT_MODE), [path])
  const focusCmRef = useRef(false)

  useEffect(
    () => () => {
      clearTimeout(saveStateTimer.current)
      saveTokenRef.current += 1
    },
    []
  )

  useEffect(() => {
    if (!cmMenu) return
    const close = (): void => setCmMenu(null)
    window.addEventListener('blur', close)
    return () => window.removeEventListener('blur', close)
  }, [cmMenu])

  const save = (): void => {
    clearTimeout(saveStateTimer.current)
    const token = ++saveTokenRef.current
    setSaveState('saving')
    void import('./buffers')
      .then(({ saveBuffer }) => saveBuffer(workspaceDir, path))
      .then((result) => {
        if (saveTokenRef.current !== token) return
        if (result === 'saved') {
          setSaveState('saved')
          saveStateTimer.current = setTimeout(() => {
            if (saveTokenRef.current !== token) return
            setSaveState(null)
          }, SAVE_FEEDBACK_MS)
        } else {
          setSaveState(null)
        }
      })
      .catch((e) => {
        if (saveTokenRef.current !== token) return
        setError(cleanError(e))
        setSaveState(null)
      })
  }

  const mediaKind = classifyMediaKind(path)
  const isMediaPreview = mediaKind === 'image' || mediaKind === 'video' || mediaKind === 'audio'
  const isMarkdown = mediaKind === 'markdown'

  useEffect(() => {
    let cancelled = false
    setReady(false)
    setError(null)
    if (!path) {
      setPreviewState(null)
      return () => {
        cancelled = true
      }
    }
    if (isPreviewBlocked(classifyMediaKind(path))) {
      setPreviewState({ kind: 'unsupported' })
      return () => {
        cancelled = true
      }
    }
    if (isMediaPreview) {
      setPreviewState(null)
      return () => {
        cancelled = true
      }
    }
    setPreviewState({ kind: 'loading' })
    const releaseBuffer = retainBuffer(workspaceDir, path)
    import('./buffers')
      .then(({ ensureBuffer }) => ensureBuffer(workspaceDir, path, save))
      .then(() => {
        if (cancelled) return
        setPreviewState(null)
        setReady(true)
      })
      .catch((e) => {
        if (cancelled) return
        setPreviewState(classifyReadError(cleanError(e)))
      })
    return () => {
      cancelled = true
      releaseBuffer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceDir, path])

  useEffect(() => {
    if (!ready || !hostRef.current || viewRef.current) return
    const buf = getBuffer(workspaceDir, path)
    if (!buf) return
    let cancelled = false
    void import('@codemirror/view').then(({ EditorView }) => {
      if (cancelled || !hostRef.current || viewRef.current) return
      viewRef.current = new EditorView({ parent: hostRef.current, state: buf.state })
    })
    return () => {
      cancelled = true
      const view = viewRef.current
      if (view) {
        view.destroy()
        viewRef.current = null
        viewGenRef.current += 1
      }
    }
  }, [ready, workspaceDir, path])

  useEffect(() => {
    if (!ready) return
    return subscribeBuffer(workspaceDir, path, () => {
      const buf = getBuffer(workspaceDir, path)
      const view = viewRef.current
      if (buf && view && view.state !== buf.state) {
        view.setState(buf.state)
        viewGenRef.current += 1
      }
      bump((n) => n + 1)
    })
  }, [ready, workspaceDir, path])

  useEffect(() => {
    if (!ready) return
    const reveal = (req: RevealRequest): void => {
      const view = viewRef.current
      if (!view) return
      const ln = Math.min(Math.max(1, req.line), view.state.doc.lines)
      const lineInfo = view.state.doc.line(ln)
      const pos = Math.min(lineInfo.from + Math.max(0, (req.col ?? 1) - 1), lineInfo.to)
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    }
    const pending = takePendingReveal(workspaceDir, path)
    if (pending) reveal(pending)
    return onReveal(workspaceDir, path, reveal)
  }, [ready, workspaceDir, path])

  const buf = getBuffer(workspaceDir, path)
  const markdownReady = isMarkdown && ready && !previewState
  const showMarkdownPreview = markdownReady && mdMode === 'preview'

  useEffect(() => {
    if (isMarkdown) preloadMarkdownPipeline()
  }, [isMarkdown, path])

  useEffect(() => {
    if (!focusCmRef.current || showMarkdownPreview) return
    focusCmRef.current = false
    viewRef.current?.focus()
  })

  const toggleMarkdownMode = (): void => {
    if (mdMode === 'preview') focusCmRef.current = true
    setMdMode((m) => (m === 'preview' ? 'edit' : 'preview'))
  }

  return {
    workspaceDir,
    path,
    hostRef,
    viewRef,
    viewGenRef,
    ready,
    buf,
    previewState,
    error,
    setError,
    saveState,
    save,
    mediaKind,
    isMediaPreview,
    isMarkdown,
    markdownReady,
    showMarkdownPreview,
    mdMode,
    toggleMarkdownMode,
    cmMenu,
    setCmMenu
  }
}
