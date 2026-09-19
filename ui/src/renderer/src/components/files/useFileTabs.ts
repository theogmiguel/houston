import { useCallback, useEffect, useState } from 'react'
import { basename, getBuffer, retainBuffer, subscribeBuffer, type EditorBuffer } from '../../editor/bufferStore'
import { caretLabel, caretPosition, languageLabel, PLAIN_TEXT_LABEL } from '../../editor/statusStrip'
import { useEditorSurface, type EditorSurfaceState } from '../../editor/useEditorSurface'

export interface FileTab {
  path: string
  preview: boolean
  missing: boolean
}

export interface FileTabsState {
  tabs: FileTab[]
  activePath: string | null
  setActivePath: (path: string) => void
  confirmClose: string | null
  closeSaving: boolean
  surface: EditorSurfaceState
  activeBuf: EditorBuffer | undefined
  dirty: boolean
  caret: string | null
  langLabel: string
  previewFile: (path: string) => void
  pinFile: (path: string) => void
  requestCloseTab: (path: string) => void
  closeOthers: (path: string) => void
  closeToRight: (path: string) => void
  closeSaved: () => void
  cancelCloseTab: () => void
  discardAndClose: () => void
  saveAndClose: (onError: (message: string) => void) => void
  markMissing: (path: string, missing: boolean) => void
  labelFor: (path: string) => string
}

const PERSIST_PREFIX = 'tr-files-tabs:'

function persistKey(workspaceDir: string): string {
  return `${PERSIST_PREFIX}${workspaceDir}`
}

interface PersistedTab {
  path: string
  preview: boolean
}

interface PersistedTabs {
  tabs: PersistedTab[]
  activePath: string | null
}

// Restored optimistically, and never dropped for being unverified: a file gone
// from disk surfaces as a `missing` tab once its load fails, not as a shorter
// list, so a session's strip cannot silently lose work it had open.
function loadPersisted(workspaceDir: string): { tabs: FileTab[]; activePath: string | null } {
  try {
    const raw = localStorage.getItem(persistKey(workspaceDir))
    if (!raw) return { tabs: [], activePath: null }
    const parsed = JSON.parse(raw) as Partial<PersistedTabs>
    if (!Array.isArray(parsed.tabs)) return { tabs: [], activePath: null }
    const tabs: FileTab[] = parsed.tabs
      .filter((t): t is PersistedTab => Boolean(t) && typeof t.path === 'string')
      .map((t) => ({ path: t.path, preview: Boolean(t.preview), missing: false }))
    const activePath =
      typeof parsed.activePath === 'string' && tabs.some((t) => t.path === parsed.activePath)
        ? parsed.activePath
        : (tabs[tabs.length - 1]?.path ?? null)
    return { tabs, activePath }
  } catch {
    return { tabs: [], activePath: null }
  }
}

function persist(workspaceDir: string, tabs: readonly FileTab[], activePath: string | null): void {
  const data: PersistedTabs = {
    tabs: tabs.map((t) => ({ path: t.path, preview: t.preview })),
    activePath
  }
  localStorage.setItem(persistKey(workspaceDir), JSON.stringify(data))
}

export function labelForTab(tabs: readonly { path: string }[], path: string): string {
  const base = basename(path)
  const collides = tabs.some((t) => t.path !== path && basename(t.path) === base)
  if (!collides) return base
  return `${base} · ${parentName(path)}`
}

function parentName(path: string): string {
  const cut = path.lastIndexOf('/')
  const parent = cut <= 0 ? '/' : path.slice(0, cut)
  return basename(parent) || parent
}

export function useFileTabs(workspaceDir: string): FileTabsState {
  const [tabs, setTabs] = useState<FileTab[]>(() => loadPersisted(workspaceDir).tabs)
  const [activePath, setActivePath] = useState<string | null>(
    () => loadPersisted(workspaceDir).activePath
  )
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [closeSaving, setCloseSaving] = useState(false)
  const [, bumpTabs] = useState(0)

  const pinFile = useCallback((path: string): void => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path)
      if (idx === -1) return [...prev, { path, preview: false, missing: false }]
      if (!prev[idx].preview) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], preview: false }
      return next
    })
    setActivePath(path)
  }, [])

  const previewFile = useCallback((path: string): void => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev
      const previewIdx = prev.findIndex((t) => t.preview)
      const tab: FileTab = { path, preview: true, missing: false }
      if (previewIdx === -1) return [...prev, tab]
      const next = [...prev]
      next[previewIdx] = tab
      return next
    })
    setActivePath(path)
  }, [])

  const markMissing = useCallback((path: string, missing: boolean): void => {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, missing } : t)))
  }, [])

  const labelFor = useCallback((path: string): string => labelForTab(tabs, path), [tabs])

  useEffect(() => {
    persist(workspaceDir, tabs, activePath)
  }, [workspaceDir, tabs, activePath])

  useEffect(() => {
    const releases = tabs.map((t) => retainBuffer(workspaceDir, t.path))
    return () => releases.forEach((r) => r())
  }, [tabs, workspaceDir])

  useEffect(() => {
    const offs = tabs.map((t) =>
      subscribeBuffer(workspaceDir, t.path, () => {
        bumpTabs((n) => n + 1)
        if (t.preview && getBuffer(workspaceDir, t.path)?.dirty) pinFile(t.path)
      })
    )
    return () => offs.forEach((off) => off())
  }, [tabs, workspaceDir, pinFile])

  const surface = useEditorSurface(workspaceDir, activePath ?? '')
  const activeBuf = activePath ? getBuffer(workspaceDir, activePath) : undefined
  const dirty = Boolean(activeBuf?.dirty)

  const [caret, setCaret] = useState<string | null>(null)
  useEffect(() => {
    if (!activePath) {
      setCaret(null)
      return
    }
    const read = (): void => {
      const view = surface.viewRef.current
      setCaret(view ? caretLabel(caretPosition(view.state)) : null)
    }
    read()
    document.addEventListener('selectionchange', read)
    const off = subscribeBuffer(workspaceDir, activePath, read)
    return () => {
      document.removeEventListener('selectionchange', read)
      off()
    }
  }, [activePath, workspaceDir, surface.viewRef, surface.ready])

  const [langLabel, setLangLabel] = useState(PLAIN_TEXT_LABEL)
  useEffect(() => {
    if (!activePath) {
      setLangLabel(PLAIN_TEXT_LABEL)
      return
    }
    let cancelled = false
    void languageLabel(activePath).then((label) => {
      if (!cancelled) setLangLabel(label)
    })
    return () => {
      cancelled = true
    }
  }, [activePath])

  const closeTab = useCallback((path: string): void => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path)
      if (idx === -1) return prev
      const next = prev.filter((t) => t.path !== path)
      setActivePath((cur) => {
        if (cur !== path) return cur
        return next[Math.min(idx, next.length - 1)]?.path ?? null
      })
      return next
    })
  }, [])

  const requestCloseTab = useCallback(
    (path: string): void => {
      if (getBuffer(workspaceDir, path)?.dirty) setConfirmClose(path)
      else closeTab(path)
    },
    [workspaceDir, closeTab]
  )

  const closeExcept = useCallback(
    (keep: (t: FileTab, idx: number, all: readonly FileTab[]) => boolean): void => {
      setTabs((prev) => {
        const kept = prev.filter((t, i) => keep(t, i, prev) || getBuffer(workspaceDir, t.path)?.dirty)
        setActivePath((cur) => (kept.some((t) => t.path === cur) ? cur : (kept[kept.length - 1]?.path ?? null)))
        return kept
      })
    },
    [workspaceDir]
  )

  const closeOthers = useCallback(
    (path: string): void => closeExcept((t) => t.path === path),
    [closeExcept]
  )

  const closeToRight = useCallback(
    (path: string): void =>
      closeExcept((_t, i, all) => {
        const idx = all.findIndex((x) => x.path === path)
        return idx === -1 || i <= idx
      }),
    [closeExcept]
  )

  const closeSaved = useCallback((): void => closeExcept(() => false), [closeExcept])

  const cancelCloseTab = useCallback((): void => setConfirmClose(null), [])

  const discardAndClose = useCallback((): void => {
    if (!confirmClose) return
    closeTab(confirmClose)
    setConfirmClose(null)
  }, [confirmClose, closeTab])

  const saveAndClose = useCallback(
    (onError: (message: string) => void): void => {
      if (!confirmClose) return
      const path = confirmClose
      setCloseSaving(true)
      void saveThenClose(workspaceDir, path)
        .then(() => {
          closeTab(path)
          setConfirmClose(null)
        })
        .catch((e: unknown) => onError(String((e as Error)?.message ?? e)))
        .finally(() => setCloseSaving(false))
    },
    [confirmClose, workspaceDir, closeTab]
  )

  return {
    tabs,
    activePath,
    setActivePath,
    confirmClose,
    closeSaving,
    surface,
    activeBuf,
    dirty,
    caret,
    langLabel,
    previewFile,
    pinFile,
    requestCloseTab,
    closeOthers,
    closeToRight,
    closeSaved,
    cancelCloseTab,
    discardAndClose,
    saveAndClose,
    markMissing,
    labelFor
  }
}

async function saveThenClose(workspaceDir: string, path: string): Promise<void> {
  const { saveBuffer } = await import('../../editor/buffers')
  const result = await saveBuffer(workspaceDir, path)
  if (result === 'conflict') {
    throw new Error(
      `${basename(path)} changed on disk — reload or overwrite it before closing (its save did not go through)`
    )
  }
}
