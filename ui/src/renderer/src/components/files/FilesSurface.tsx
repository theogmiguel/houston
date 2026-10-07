import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilesSurfaceClass, filesSurfaceClass } from '../ui/FilesSurfaceElement'
import type { ComponentProps } from 'react'
import type { DirEntry } from '../../env'
import type { GitFileStatus, HoustonClient } from '../../houston/client'
import { basename, reloadBuffer } from '../../editor/buffers'
import { updateFilesDiffGutter } from '../../editor/filesDiffGutter'
import { parseFileDiffLines, type FileDiffLines } from './fileDiffLines'
import { EditorSurfaceBody } from '../EditorSurface'
import {
  createDirectory,
  createFile,
  onFilesChanged,
  readDir,
  renameFile,
  searchFilePaths,
  trashFile,
  unwatchFileDirs,
  watchFileDirs,
} from '../../houston/bridge'
import { useFileTabs } from './useFileTabs'
import { flattenTree, sortEntries, treeKeyAction } from './filesTree'
import { copyFilePath } from './fileActions'
import { QuickOpen, useQuickOpenShortcut } from './QuickOpen'
import { Explorer } from './FilesExplorer'
import { FilesContextMenu, FilesExplorerPlacement, FilesPreview, FilesSubheader } from './FilesSurfaceParts'
import { IconClock } from '../icons'
import { Icon } from '../ui/Icon'
import '../ui/filesSurface.css'

export interface FilesSurfaceProps {
  workspaceRoot: string
  panelWidth: number
  onOpenInEditor?: (path: string) => void
  onSendPath?: (path: string) => void
  onOpenFile?: (path: string) => void
  onActiveFileChange?: (name: string | null) => void
  quickOpenRequest?: number
  client?: HoustonClient | null
  onError?: (message: string) => void
  className?: string
}

function parent(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? (i === 0 ? '/' : '') : path.slice(0, i)
}
function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function fileSearchPath(root: string, path: string): string {
  return `${root}/${path}`
}

function searchIndices(indices: number[] | null | undefined): number[] {
  return indices ?? []
}

function filePreviewModes(path: string | null, rendered: Record<string, boolean>): {
  isRendered: boolean
  isCsv: boolean
  isMarkdown: boolean
  isImage: boolean
  isText: boolean
} {
  const ext = path ? extension(path) : ''
  const isRendered = path ? rendered[path] !== false : false
  const isCsv = path !== null && ['csv', 'tsv'].includes(ext)
  const isMarkdown = path !== null && ext === 'md'
  const isImage = path !== null && /^(png|jpe?g|gif|webp|svg)$/.test(ext)
  return { isRendered, isCsv, isMarkdown, isImage, isText: path !== null && !isImage && !(isCsv && isRendered) }
}

function isExplorerVisible(layout: 'wide' | 'sheet', sheet: boolean, explorer: boolean): boolean {
  return layout === 'sheet' ? sheet : explorer
}

function panelDataFlag(enabled: boolean): true | undefined {
  return enabled || undefined
}

function pathFromContext(context: { path: string } | null): string | null {
  return context?.path ?? null
}

export function filesSurfaceLayout(width: number): 'wide' | 'sheet' {
  return width < 560 ? 'sheet' : 'wide'
}

function FilesOpenFile({
  path,
  subheader,
  diskChanged,
  onKeepMine,
  onReload,
  preview,
  explorer,
}: {
  path: string
  subheader: ComponentProps<typeof FilesSubheader>
  diskChanged: boolean
  onKeepMine: () => void
  onReload: () => void
  preview: Omit<ComponentProps<typeof FilesPreview>, 'path'>
  explorer: ComponentProps<typeof FilesExplorerPlacement>
}): React.JSX.Element {
  return (
    <>
      <FilesSubheader {...subheader} />
      {diskChanged && (
        <div className={filesSurfaceClass(FilesSurfaceClass.banner)} role="alert">
          <Icon glyph={IconClock} role="small" />
          <span className={filesSurfaceClass(FilesSurfaceClass.spacer)}>{basename(path)} changed on disk while you were editing.</span>
          <button className={filesSurfaceClass(FilesSurfaceClass.bannerGhost)} onClick={onKeepMine}>Keep mine</button>
          <button onClick={onReload}>Reload</button>
        </div>
      )}
      <div className={filesSurfaceClass(FilesSurfaceClass.main)}>
        <FilesPreview path={path} {...preview} />
        <FilesExplorerPlacement {...explorer} />
      </div>
    </>
  )
}

function FilesSurfaceOverlays({
  context,
  contextMenuRef,
  root,
  onError,
  onSendPath,
  onOpen,
  setContext,
  setExpanded,
  setMutation,
  setDeletePath,
  quickOpen,
  rootName,
  closeQuickOpen,
  openQuickFile,
}: {
  context: { path: string; dir: boolean; x: number; y: number } | null
  contextMenuRef: React.RefObject<HTMLDivElement | null>
  root: string
  onError?: (message: string) => void
  onSendPath?: (path: string) => void
  onOpen: (path: string) => void
  setContext: (value: { path: string; dir: boolean; x: number; y: number } | null) => void
  setExpanded: (value: Set<string> | ((old: Set<string>) => Set<string>)) => void
  setMutation: React.Dispatch<React.SetStateAction<{ kind: 'rename' | 'file' | 'directory'; path: string; name: string; error?: string } | null>>
  setDeletePath: (value: string | null) => void
  quickOpen: boolean
  rootName: string
  closeQuickOpen: () => void
  openQuickFile: (selected: string) => void
}): React.JSX.Element {
  return (
    <>
      {context && (
        <FilesContextMenu
          context={context}
          contextMenuRef={contextMenuRef}
          root={root}
          onError={onError}
          onSendPath={onSendPath}
          onOpen={onOpen}
          setContext={setContext}
          setExpanded={setExpanded}
          setMutation={setMutation}
          setDeletePath={setDeletePath}
        />
      )}
      {quickOpen && (
        <QuickOpen
          root={root}
          workspaceName={rootName}
          onClose={closeQuickOpen}
          onOpen={openQuickFile}
        />
      )}
    </>
  )
}

function handleTreeKeyShortcut(
  event: React.KeyboardEvent<HTMLDivElement>,
  row: ReturnType<typeof flattenTree>[number] | undefined,
  filtering: boolean,
  handlers: {
    setMutation: (value: { kind: 'rename'; path: string; name: string }) => void
    setDeletePath: (path: string) => void
    setFilter: (value: string) => void
    copyPath: (path: string) => unknown
    focusSearch: () => void
  },
): boolean {
  if (event.key === 'F2' && row && !filtering) {
    event.preventDefault()
    handlers.setMutation({ kind: 'rename', path: row.path, name: row.name })
    return true
  }
  if (event.key === 'Delete' && row && !filtering) {
    event.preventDefault()
    handlers.setDeletePath(row.path)
    return true
  }
  if (event.key === 'c' && (event.ctrlKey || event.metaKey) && row) {
    event.preventDefault()
    void handlers.copyPath(row.path)
    return true
  }
  if (event.key.length === 1 && !/\s/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    handlers.setFilter(event.key)
    window.setTimeout(handlers.focusSearch, 0)
    return true
  }
  return false
}

function applyTreeKeyAction(
  action: ReturnType<typeof treeKeyAction>,
  handlers: {
    preventDefault: () => void
    setFocusIndex: (index: number) => void
    setExpanded: (value: (old: Set<string>) => Set<string>) => void
    loadDir: (path: string) => Promise<DirEntry[]>
    hasDirectory: (path: string) => boolean
    openFile: (path: string) => void
  },
): void {
  if (action.kind === 'none') return
  handlers.preventDefault()
  if (action.kind === 'focus') handlers.setFocusIndex(action.index)
  else if (action.kind === 'expand') {
    handlers.setExpanded((old) => new Set(old).add(action.path))
    if (!handlers.hasDirectory(action.path)) void handlers.loadDir(action.path)
  } else if (action.kind === 'collapse') {
    handlers.setExpanded((old) => {
      const next = new Set(old)
      next.delete(action.path)
      return next
    })
  } else handlers.openFile(action.path)
}

export function FilesSurface({
  workspaceRoot,
  panelWidth,
  onSendPath,
  onOpenFile,
  onActiveFileChange,
  quickOpenRequest,
  client,
  onError,
  className = '',
}: FilesSurfaceProps): React.JSX.Element {
  const root = workspaceRoot
  const files = useFileTabs(root)
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [searchResults, setSearchResults] = useState<
    { path: string; displayPath: string; name: string; nameIndices: number[]; pathIndices: number[] }[]
  >([])
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([])
  const [isGitRepository, setIsGitRepository] = useState<boolean | null>(null)
  const [fileDiff, setFileDiff] = useState<FileDiffLines | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [explorer, setExplorer] = useState(true)
  const [animateFromFull, setAnimateFromFull] = useState(false)
  const [returnToTree, setReturnToTree] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [rendered, setRendered] = useState<Record<string, boolean>>({})
  const [wrap, setWrap] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [crumbsOpen, setCrumbsOpen] = useState(false)
  const [crumbOverflow, setCrumbOverflow] = useState(false)
  const crumbsTrailRef = useRef<HTMLSpanElement>(null)
  const [mutation, setMutation] = useState<{
    kind: 'rename' | 'file' | 'directory'
    path: string
    name: string
    error?: string
  } | null>(null)
  const [deletePath, setDeletePath] = useState<string | null>(null)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const [diskChanged, setDiskChanged] = useState(false)
  const [flashPaths, setFlashPaths] = useState<Set<string>>(new Set())
  const [context, setContext] = useState<{ path: string; dir: boolean; x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const surfaceRef = useRef<HTMLElement>(null)
  const previousQuickOpenRequest = useRef(quickOpenRequest)
  const path = files.activePath
  const layout = filesSurfaceLayout(panelWidth)
  const rootName = basename(root) || root
  const content = files.activeBuf?.state.doc.toString() ?? ''
  useEffect(() => {
    onActiveFileChange?.(path ? basename(path) : null)
  }, [onActiveFileChange, path])
  useEffect(() => {
    const trail = crumbsTrailRef.current
    if (!trail || typeof ResizeObserver === 'undefined') return
    const update = (): void => setCrumbOverflow(trail.scrollWidth > trail.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(trail)
    return () => observer.disconnect()
  }, [path, panelWidth])
  useLayoutEffect(() => {
    if (!context || !contextMenuRef.current) return
    const menu = contextMenuRef.current.getBoundingClientRect()
    const left = Math.min(context.x, window.innerWidth - menu.width - 8)
    const top = Math.min(context.y, window.innerHeight - menu.height - 8)
    if (left !== context.x || top !== context.y)
      setContext((current) => (current ? { ...current, x: left, y: top } : current))
  }, [context])
  useEffect(() => {
    if (!context) return
    const dismiss = (event: PointerEvent): void => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContext(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [context])

  const openQuick = useCallback(() => setQuickOpen(true), [])
  useQuickOpenShortcut(openQuick)
  useEffect(() => {
    if (previousQuickOpenRequest.current === quickOpenRequest) return
    previousQuickOpenRequest.current = quickOpenRequest
    setQuickOpen(true)
  }, [quickOpenRequest])

  const loadDir = useCallback(
    async (dir: string): Promise<DirEntry[]> => {
      try {
        const listing = sortEntries(await readDir(dir))
        setEntries((old) => new Map(old).set(dir, listing))
        return listing
      } catch (error) {
        onError?.(String(error))
        return []
      }
    },
    [onError],
  )
  const refresh = useCallback(() => {
    void loadDir(root)
    expanded.forEach((dir) => void loadDir(dir))
  }, [root, expanded, loadDir])
  useEffect(() => {
    void loadDir(root)
  }, [loadDir, root])

  useEffect(() => {
    setIsGitRepository(null)
    if (!client) return
    const off = client.subscribe('git_status', (message) => {
      if (message.dir !== root || message.base != null) return
      setGitFiles(message.files)
      setIsGitRepository(!message.not_a_repo)
    })
    client.gitStatus(root, null)
    return off
  }, [client, root])

  const relativeFilePath = path?.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
  useEffect(() => {
    setFileDiff(null)
    if (!client || !relativeFilePath || isGitRepository !== true || files.dirty) return
    const off = client.subscribe('git_diff', (message) => {
      if (message.dir !== root || message.path !== relativeFilePath || message.base != null) return
      setFileDiff(message.truncated ? null : parseFileDiffLines(message.patch))
    })
    client.gitDiff(root, relativeFilePath)
    return off
  }, [client, root, relativeFilePath, isGitRepository, files.dirty])

  useEffect(() => {
    if (!files.surface.ready) return
    const empty: FileDiffLines = { added: new Set(), modified: new Set(), deleted: new Set() }
    const frame = window.requestAnimationFrame(() => {
      const view = files.surface.viewRef.current
      if (view) updateFilesDiffGutter(view, files.dirty ? empty : fileDiff ?? empty)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [fileDiff, files.dirty, files.surface.ready, files.surface.viewRef, path])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    let watchLeaseReady = false
    const dirs = [...new Set([root, ...expanded, ...(path ? [parent(path)] : [])])]
    void watchFileDirs(root, dirs)
      .then(() => {
        watchLeaseReady = true
        if (disposed) return unwatchFileDirs(root)
      })
      .catch((error: unknown) => onError?.(String(error)))
    void onFilesChanged((event) => {
      if (event.root !== root) return
      refresh()
      setFlashPaths(new Set(event.paths))
      window.setTimeout(() => setFlashPaths(new Set()), 900)
      if (path && event.paths.includes(path)) {
        if (files.dirty) setDiskChanged(true)
        else void reloadBuffer(root, path)
          .then(() => {
            if (client && relativeFilePath && isGitRepository) client.gitDiff(root, relativeFilePath)
          })
          .catch((error: unknown) => onError?.(String(error)))
      }
    }).then((off) => {
      if (disposed) off()
      else unlisten = off
    })
    return () => {
      disposed = true
      unlisten?.()
      if (watchLeaseReady) void unwatchFileDirs(root).catch((error: unknown) => onError?.(String(error)))
    }
  }, [root, expanded, path, files.dirty, refresh, onError, client, relativeFilePath, isGitRepository])

  useEffect(() => {
    if (!filter.trim()) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }
    let cancelled = false
    setSearchLoading(true)
    const timer = window.setTimeout(() => {
      void searchFilePaths(root, filter, 200)
        .then((result) => {
          if (!cancelled) {
            setSearchResults(
              result.items
                .filter((item) => !item.isDir)
                .map((item) => ({
                  ...item,
                  nameIndices: searchIndices(item.nameIndices),
                  pathIndices: searchIndices(item.pathIndices),
                  displayPath: item.path,
                  path: fileSearchPath(root, item.path),
                })),
            )
            setSearchTruncated(result.truncated)
          }
        })
        .catch((error) => {
          if (!cancelled) onError?.(String(error))
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false)
        })
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [filter, root, onError])

  const rows = useMemo(() => flattenTree(root, entries, expanded), [root, entries, expanded])
  const ignoredPaths = useMemo(
    () =>
      new Set(
        [...entries.values()]
          .flat()
          .filter((entry) => entry.ignored)
          .map((entry) => entry.path),
      ),
    [entries],
  )
  const visibleRows = useMemo(() => {
    if (!filter.trim()) return rows
    const allowed = new Set<string>()
    rows.forEach((row, i) => {
      if (row.name.toLowerCase().includes(filter.toLowerCase())) {
        allowed.add(row.path)
        let depth = row.depth
        for (let j = i - 1; j >= 0 && depth; j--)
          if (rows[j].depth < depth) {
            allowed.add(rows[j].path)
            depth = rows[j].depth
          }
      }
    })
    return rows.filter((row) => allowed.has(row.path))
  }, [rows, filter])
  const displayRows = useMemo(
    () =>
      flattenTree(root, entries, new Set(entries.keys())).map((row) => ({ ...row, expanded: expanded.has(row.path) })),
    [root, entries, expanded],
  )

  const openFile = (file: string): void => {
    if (!path && panelWidth >= 560) setAnimateFromFull(true)
    files.pinFile(file)
    setSheet(false)
    setDiskChanged(false)
    onOpenFile?.(file)
  }
  useEffect(() => {
    if (!animateFromFull || !path) return
    const frame = window.requestAnimationFrame(() => setAnimateFromFull(false))
    return () => window.cancelAnimationFrame(frame)
  }, [animateFromFull, path])
  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const keyboardRows = filter.trim()
      ? searchResults.map((item) => ({ ...item, dir: false, depth: 0, expanded: false }))
      : visibleRows
    const row = keyboardRows[focusIndex]
    if (handleTreeKeyShortcut(event, row, filter.trim() !== '', {
      setMutation,
      setDeletePath,
      setFilter,
      copyPath: (target) => copyFilePath(target, (message) => onError?.(message)),
      focusSearch: () => surfaceRef.current?.querySelector<HTMLInputElement>('.files-search input')?.focus(),
    })) return
    const action = treeKeyAction(keyboardRows, focusIndex, event.key)
    applyTreeKeyAction(action, {
      preventDefault: () => event.preventDefault(),
      setFocusIndex,
      setExpanded,
      loadDir,
      hasDirectory: (target) => entries.has(target),
      openFile,
    })
  }

  const submitMutation = async (): Promise<void> => {
    if (!mutation) return
    const name = mutation.name.trim()
    if (!name || /[\/\\\u0000-\u001f\u007f]/.test(name)) {
      setMutation({
        ...mutation,
        error: `Cannot use ${JSON.stringify(name)}: expected a single non-empty filename without slashes`,
      })
      return
    }
    const dir = mutation.kind === 'rename' ? parent(mutation.path) : mutation.path
    const target = `${dir}/${name}`.replace(/^\//, '/')
    try {
      if (mutation.kind === 'rename') await renameFile(mutation.path, target)
      else if (mutation.kind === 'file') await createFile(target)
      else await createDirectory(target)
      setMutation(null)
      refresh()
      if (mutation.kind === 'file') openFile(target)
    } catch (error) {
      setMutation({ ...mutation, error: String(error) })
    }
  }

  const confirmDelete = (): void => {
    if (!deletePath) return
    const target = deletePath
    setDeletingPath(target)
    window.setTimeout(() => {
      void trashFile(target)
        .then(() => {
          if (path === target || path?.startsWith(`${target}/`)) files.setActivePath('')
          setDeletePath(null)
          setDeletingPath(null)
          refresh()
        })
        .catch((error: unknown) => {
          setDeletePath(null)
          setDeletingPath(null)
          onError?.(String(error))
        })
    }, 150)
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Node) || !surfaceRef.current?.contains(event.target)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && path) {
        event.preventDefault()
        files.surface.save()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        if (layout === 'sheet') setSheet((old) => !old)
        else setExplorer((old) => !old)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [files.surface, path, layout])

  const toggleRendered = (): void => {
    if (isMarkdown) files.surface.toggleMarkdownMode()
    setRendered((old) => ({ ...old, [path ?? '']: old[path ?? ''] === false }))
  }
  const { isRendered, isCsv, isMarkdown, isImage, isText } = filePreviewModes(path, rendered)
  const explorerVisible = isExplorerVisible(layout, sheet, explorer)
  const width = Math.min(352, Math.max(256, Math.round(panelWidth * 0.46)))
  const shownRows = filter ? searchResults : null
  const explorerProps = {
    root,
    rootName,
    filter,
    setFilter,
    refresh,
    onNew: () => {
      setFilter('')
      setMutation({ kind: 'file', path: root, name: '' })
    },
    expanded,
    setExpanded,
    entries,
    loadDir,
    rows: visibleRows,
    displayRows,
    activePath: path,
    contextPath: pathFromContext(context),
    onOpen: openFile,
    onContext: (p: string, dir: boolean, x: number, y: number) => {
      setContext({ path: p, dir, x, y })
    },
    onKeyDown: onTreeKeyDown,
    focusIndex,
    setFocusIndex,
    gitFiles,
    flashPaths,
    ignoredPaths,
    searchResults: shownRows,
    searchLoading,
    searchTruncated,
    mutation,
    setMutation,
    submitMutation: () => {
      void submitMutation()
    },
    deletePath,
    deletingPath,
    onConfirmDelete: confirmDelete,
    onCancelDelete: () => setDeletePath(null),
  }

  return (
    <section
      ref={surfaceRef}
      className={`${filesSurfaceClass(FilesSurfaceClass.surface)} ${className}`}
      data-testid="files-surface"
      data-layout={layout}
      data-width={panelWidth}
      data-panel-compact={panelDataFlag(panelWidth < 400)}
      data-panel-crumb-collapsed={panelDataFlag(panelWidth < 470)}
      style={{ '--files-explorer-width': `${width}px` } as React.CSSProperties}
    >
      {!path ? (
        <div className={filesSurfaceClass(FilesSurfaceClass.main)}>
          <aside className={filesSurfaceClass(FilesSurfaceClass.explorer)} aria-label="File explorer">
            <Explorer {...explorerProps} />
          </aside>
        </div>
      ) : (
        <FilesOpenFile
          path={path}
          subheader={{
            root,
            rootName,
            path,
            panelWidth,
            layout,
            explorer,
            dirty: files.dirty,
            crumbsTrailRef,
            crumbOverflow,
            crumbsOpen,
            setCrumbsOpen,
            setReturnToTree,
            setSheet,
            setActivePath: files.setActivePath,
            setExpanded,
            loadDir,
            onError,
            isMarkdown,
            isCsv,
            isText,
            isRendered,
            toggleRendered,
            wrap,
            setWrap,
            moreOpen,
            setMoreOpen,
            explorerVisible,
            setExplorer,
          }}
          diskChanged={diskChanged}
          onKeepMine={() => setDiskChanged(false)}
          onReload={() => {
            void reloadBuffer(root, path)
              .then(() => setDiskChanged(false))
              .catch((error) => onError?.(String(error)))
          }}
          preview={{
            ready: files.surface.ready,
            isImage,
            isCsv,
            isMarkdown,
            isRendered,
            content,
            wrap,
            returnToTree,
            surface: files.surface,
            editor: EditorSurfaceBody,
          }}
          explorer={{
            layout,
            sheet,
            setSheet,
            explorer,
            animateFromFull,
            returnToTree,
            panelWidth,
            explorerProps,
          }}
        />
      )}
      <FilesSurfaceOverlays
        context={context}
        contextMenuRef={contextMenuRef}
        root={root}
        onError={onError}
        onSendPath={onSendPath}
        onOpen={openFile}
        setContext={setContext}
        setExpanded={setExpanded}
        setMutation={setMutation}
        setDeletePath={setDeletePath}
        quickOpen={quickOpen}
        rootName={rootName}
        closeQuickOpen={() => setQuickOpen(false)}
        openQuickFile={(selected) => {
          openFile(`${root}/${selected}`)
          setQuickOpen(false)
        }}
      />
    </section>
  )
}
