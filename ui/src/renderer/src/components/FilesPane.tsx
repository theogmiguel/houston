import { FILES_TREE_MIN, FILES_TREE_MAX, useFilesSplit } from './files/useFilesSplit'
import { filesTreeToggleMatches } from '../keymap'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import type { GitFileStatus, HoustonClient } from '../houston/client'
import { FILE_REFERENCE_MIME, copyFilePath, fileActionDirectory, fileReference, gitTreeStatus, relativeFilePath } from './files/fileActions'
import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RING_ACCENT_ICON } from './ui/shadowChrome'
import type { DirEntry } from '../env'
import type { FilesNode, PaneKey } from '../layout/tree'
import { readDir, showItemInFolder, createFile, createDirectory, renameFile, trashFile } from '../houston/bridge'
import { BTN_ICO_STRUCTURE } from './ui/buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import {
  usePaneFocusTier
} from '../windowFocus'
import { basename, getBuffer } from '../editor/bufferStore'
import { PaneHeader, PaneTitle } from './ui'
import { SaveIndicator } from '../editor/SaveIndicator'
import { classifyFileTreeEntry, FileTreeIcon } from './fileTreeIcons'
import { filterTreeRows, flattenTree, treeKeyAction, visibleEntries, type TreeRow } from './files/filesTree'
import { useFileTabs, type FileTab, type FileTabsState } from './files/useFileTabs'
import {
  IconArrowUpRight,
  IconChevronDown,
  IconChevronLeft,
  IconPlus,
  IconSearch,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconMaximize,
  IconMinimize,
  IconPanelLeft,
  IconRefresh,
  IconSave
} from './icons'
import { Tooltip } from './ui/Tooltip'
import { MarkdownPreviewToggle } from './MarkdownPreview'
import { AnimOut, MenuLayer } from './ui/AnimOut'
import { OpenInMenu } from './OpenInMenu'
import { SaveDiscardModal } from './SaveDiscardModal'
import { Icon } from './ui/Icon'
import { Button, MenuItem } from './ui'
import { popOriginStyle } from './ui/overlayChrome'
import {
  Breadcrumb, BreadcrumbCurrent, BreadcrumbLink, BreadcrumbSegment, EditorColumn, ExplorerColumns, ExplorerMenu, ExplorerMenuCaption, ExplorerMenuItem,
  ExplorerMenuSeparator, FileTab as TabItem, NameForm,
  NameInput, NoticeAction, PaneNotice, PaneNoticeHint, PaneNoticeTitle, PlainButton, SplitIconButton, StatusCell, StatusStrip,
  TabCloseButton, TabError, TabGitMark, TabLabel, TabOverflowButton, TabScroll, TabStrip, TreeColumn, TreeFilter, TreeFilterInput,
  TreeHead, TreeRow as TreeItemButton, TreeRowLabel, TreeRowStatus, TreeSash, TreeScroll, TreeToggleSlot, UnsavedDot, ViewerHead, ViewerOpenButton
} from './ui/FileExplorer'

// Dynamic import: CodeMirror plus its grammars has no business loading just
// to show a file tree.
const EditorSurfaceBody = lazy(() =>
  import('./EditorSurface').then((m) => ({ default: m.EditorSurfaceBody }))
)

// 420px is where a 220px tree column plus a readable ~60-column editor line
// still both fit; below it the tree collapses to a toggleable overlay instead.
const TREE_VISIBLE = '[@container_(min-width:420px)]'
const ICO_HEAD_BASE =
  `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] [transition:background_0.16s_cubic-bezier(0.4,0,0.2,1),color_0.16s_ease,transform_0.18s_cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-px active:translate-y-0 active:scale-90 focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none`
const ICO_HEAD_NEUTRAL =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] hover:text-[var(--text-primary)]'
const ICO_HEAD_DANGER =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)]'
const ICO_HEAD_INFO =
  'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'

export interface FilesPaneProps {
  panel?: boolean
  client?: HoustonClient | null
  openFile?: { path: string; line?: number; col?: number } | null
  onMoveToEditor?: (path: string) => void
  node: FilesNode
  workspaceDir: string
  onClose: () => void
  onHeaderPointerDown: (e: React.PointerEvent) => void
  active?: boolean
  expanded?: boolean
  onExpand?: (key: PaneKey) => void
  onError?: (message: string) => void
  onSendToTerminal?: (text: string) => void
  sendToTerminalLabel?: string
}

export function FilesPane({
  panel,
  client,
  openFile,
  onMoveToEditor,
  node,
  workspaceDir,
  onClose,
  onHeaderPointerDown,
  active = false,
  expanded = false,
  onExpand,
  onError,
  onSendToTerminal,
  sendToTerminalLabel = 'focused pane'
}: FilesPaneProps): React.JSX.Element {
  const focusTier = usePaneFocusTier(active)
  const keymapOverrides = useContext(KeymapOverridesContext)
  const root = node.root ?? workspaceDir
  const split = useFilesSplit(workspaceDir, Boolean(panel))
  const [filter, setFilter] = useState('')
  const revealPathRef = useRef<string | null>(null)

  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map())
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [rootError, setRootError] = useState<string | null>(null)
  const [dirErrors, setDirErrors] = useState<Map<string, string>>(new Map())
  const [focusIndex, setFocusIndex] = useState(0)
  const [treeOpen, setTreeOpen] = useState(false)
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const pullFocusRef = useRef(false)

  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [overflowMenu, setOverflowMenu] = useState<{ x: number; y: number } | null>(null)
  const tabMenuRef = useRef<HTMLDivElement | null>(null)
  const overflowMenuRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [tabsOverflow, setTabsOverflow] = useState(false)

  const fileTabs = useFileTabs(workspaceDir)
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([])
  const [mutation, setMutation] = useState<{ kind: 'file' | 'directory' | 'rename'; path: string; name: string } | null>(null)
  useEffect(() => {
    if (openFile) fileTabs.pinFile(openFile.path)
  }, [openFile, fileTabs.pinFile])
  useEffect(() => {
    setGitFiles([])
    if (!client) return
    const off = client.subscribe('git_status', (message) => {
      if (message.dir === root && message.base == null) setGitFiles(message.files)
    })
    client.gitStatus(root, null)
    return off
  }, [client, root])

  const readInto = useCallback(async (dir: string, isRoot: boolean): Promise<void> => {
    try {
      const entries = await readDir(dir)
      setChildren((prev) => new Map(prev).set(dir, visibleEntries(entries)))
      if (isRoot) setRootError(null)
      else
        setDirErrors((prev) => {
          if (!prev.has(dir)) return prev
          const next = new Map(prev)
          next.delete(dir)
          return next
        })
    } catch (e) {
      const message = String((e as Error)?.message ?? e)
      if (isRoot) setRootError(message)
      else setDirErrors((prev) => new Map(prev).set(dir, message))
    }
  }, [])

  useEffect(() => {
    void readInto(root, true)
  }, [root, readInto])

  const refreshTree = useCallback((): void => {
    void readInto(root, true)
    for (const dir of expandedDirs) void readInto(dir, false)
  }, [root, expandedDirs, readInto])

  const rows = useMemo(
    () => filterTreeRows(flattenTree(root, children, expandedDirs), split.split ? filter : ''),
    [root, children, expandedDirs, filter, split.split]
  )

  const expandDir = useCallback(
    (path: string): void => {
      setExpandedDirs((prev) => new Set(prev).add(path))
      setChildren((prev) => {
        if (!prev.has(path)) void readInto(path, false)
        return prev
      })
    },
    [readInto]
  )
  const collapseDir = useCallback((path: string): void => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }, [])

  useEffect(() => {
    if (!fileTabs.activePath) return
    for (const dir of ancestorDirs(root, fileTabs.activePath)) expandDir(dir)
  }, [fileTabs.activePath, root, expandDir])

  const revealInTree = useCallback(
    (path: string): void => {
      setFilter('')
      split.reveal()
      revealPathRef.current = path
      for (const dir of ancestorDirs(root, path)) expandDir(dir)
      if (path !== root && children.get(parentDir(path))?.some((entry) => entry.path === path && entry.dir)) expandDir(path)
    },
    [root, expandDir, children, split]
  )

  useEffect(() => {
    const revealPath = revealPathRef.current
    if (revealPath) {
      const index = rows.findIndex((row) => row.path === revealPath)
      if (index !== -1) {
        revealPathRef.current = null
        setFocusIndex(index)
        rowRefs.current.get(revealPath)?.focus()
      }
    }
    if (!pullFocusRef.current) return
    pullFocusRef.current = false
    const row = rows[focusIndex]
    if (row) rowRefs.current.get(row.path)?.focus()
  })

  const onTreeKeyDown = (e: React.KeyboardEvent, index: number): void => {
    const row = rows[index]
    if (row && (e.key === 'F2' || e.key === 'Delete')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'F2') setMutation({ kind: 'rename', path: row.path, name: row.name })
      else void removeEntry(row.path)
      return
    }
    const action = treeKeyAction(rows, index, e.key)
    if (action.kind === 'none') return
    e.preventDefault()
    e.stopPropagation()
    switch (action.kind) {
      case 'focus':
        pullFocusRef.current = true
        setFocusIndex(action.index)
        break
      case 'expand':
        expandDir(action.path)
        break
      case 'collapse':
        collapseDir(action.path)
        break
      case 'open':
        fileTabs.pinFile(action.path)
        break
    }
  }

  const reportError = (message: string): void => {
    if (onError) onError(message)
    else fileTabs.surface.setError(message)
  }

  const removeEntry = async (path: string): Promise<void> => {
    try {
      await trashFile(path)
      for (const tab of fileTabs.tabs) if (tab.path === path || tab.path.startsWith(`${path}/`)) fileTabs.markMissing(tab.path, true)
      refreshTree()
    } catch (error) { reportError(String(error)) }
  }
  const applyMutation = async (): Promise<void> => {
    if (!mutation) return
    const name = mutation.name
    if (!name || name === '.' || name === '..' || /[\/\\\u0000-\u001f\u007f]/.test(name)) {
      reportError(`Cannot use ${JSON.stringify(name)}: expected a single non-empty filename without traversal or control characters`)
      return
    }
    const path = `${mutation.kind === 'rename' ? parentDir(mutation.path) : mutation.path}/${name}`
    try {
      if (mutation.kind === 'rename') {
        await renameFile(mutation.path, path)
        for (const tab of fileTabs.tabs) if (tab.path === mutation.path || tab.path.startsWith(`${mutation.path}/`)) fileTabs.markMissing(tab.path, true)
        if (!rows.find((row) => row.path === mutation.path)?.dir) fileTabs.pinFile(path)
      } else if (mutation.kind === 'file') { await createFile(path); fileTabs.pinFile(path) }
      else await createDirectory(path)
      setMutation(null)
      refreshTree()
    } catch (error) { reportError(String(error)) }
  }

  useEffect(() => {
    if (!fileTabs.activePath) return
    // jsdom has no layout engine and doesn't implement scrollIntoView at all —
    // optional-call it rather than assume a test environment has it.
    tabRefs.current.get(fileTabs.activePath)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [fileTabs.activePath])

  useLayoutEffect(() => {
    const el = tabScrollRef.current
    const check = (): void => setTabsOverflow(el ? el.scrollWidth > el.clientWidth : false)
    check()
    if (!el || typeof ResizeObserver === 'undefined') return
    // A ResizeObserver on the strip itself, not a window resize listener: a
    // splitter drag resizes the strip without resizing the window, and a
    // window listener here would race CodeMirror's own resize handling.
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fileTabs.tabs])

  const overflowTabs = (): typeof fileTabs.tabs => {
    const scrollEl = tabScrollRef.current
    if (!scrollEl) return []
    const viewStart = scrollEl.scrollLeft
    const viewEnd = viewStart + scrollEl.clientWidth
    return fileTabs.tabs.filter((t) => {
      const el = tabRefs.current.get(t.path)
      if (!el) return false
      return el.offsetLeft < viewStart || el.offsetLeft + el.offsetWidth > viewEnd
    })
  }

  const rootName = basename(root) || root

  const header = (
    <PaneHeader
      data-pane-focus-head={focusTier}
      divider="dividerMuted"
      transition="surface"
      inset="compact"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        onHeaderPointerDown(e)
      }}
    >
      <span className="flex-none text-[var(--text-muted)]">
        <Icon glyph={IconFolder} role="ui" />
      </span>
      <PaneTitle>Files</PaneTitle>
      <Tooltip label={root}>
        <span
          data-testid="files-head-meta"
          className="flex-none font-mono text-[length:var(--tr-text-xs)] text-[var(--text-faint)] whitespace-nowrap overflow-hidden text-ellipsis [@container_(max-width:320px)]:hidden"
        >
          {rootName}
        </span>
      </Tooltip>
      <span className="head-actions flex items-center gap-px flex-none ml-auto">
        <FileHeaderActions root={root} panel={panel} path={fileTabs.activePath} onCreate={() => setMutation({ kind: 'file', path: root, name: '' })} onMove={onMoveToEditor} onClose={fileTabs.transferTab} />
        <span className={`${TREE_VISIBLE}:hidden inline-flex`}>
          <Tooltip label={treeOpen ? 'Hide tree' : 'Show tree'}>
            <button
              className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${treeOpen ? ICO_HEAD_INFO : ICO_HEAD_NEUTRAL}`}
              aria-label={treeOpen ? 'Hide tree' : 'Show tree'}
              aria-pressed={treeOpen}
              onClick={(e) => {
                e.stopPropagation()
                setTreeOpen((o) => !o)
              }}
            >
              <Icon glyph={IconPanelLeft} role="ui" />
            </button>
          </Tooltip>
        </span>
        {}
        {fileTabs.surface.markdownReady && (
          <MarkdownPreviewToggle
            mode={fileTabs.surface.mdMode}
            className="h-[var(--h-ctl-mini)]"
            onToggle={fileTabs.surface.toggleMarkdownMode}
          />
        )}
        <Tooltip label="Refresh tree">
          <button
            className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_NEUTRAL}`}
            aria-label="Refresh tree"
            onClick={(e) => {
              e.stopPropagation()
              refreshTree()
            }}
          >
            <Icon glyph={IconRefresh} role="ui" />
          </button>
        </Tooltip>
        <Tooltip label={fileTabs.dirty ? 'Save (Ctrl+S)' : 'No unsaved changes'}>
          <button
            className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_NEUTRAL}`}
            aria-label="Save"
            disabled={!fileTabs.dirty}
            onClick={(e) => {
              e.stopPropagation()
              fileTabs.surface.save()
            }}
          >
            {fileTabs.surface.saveState ? (
              <SaveIndicator state={fileTabs.surface.saveState} />
            ) : (
              <Icon glyph={IconSave} role="ui" />
            )}
          </button>
        </Tooltip>
        {onExpand && (
          <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
            <button
              className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${expanded ? ICO_HEAD_INFO : ICO_HEAD_NEUTRAL}`}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              aria-pressed={expanded}
              onClick={(e) => {
                e.stopPropagation()
                onExpand(node.id)
              }}
            >
              {expanded ? <Icon glyph={IconMinimize} role="ui" /> : <Icon glyph={IconMaximize} role="ui" />}
            </button>
          </Tooltip>
        )}
        <Tooltip label="Close pane">
          <button
            className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_DANGER}`}
            aria-label="Close"
            onClick={onClose}
          >
            <Icon glyph={IconClose} role="ui" />
          </button>
        </Tooltip>
      </span>
    </PaneHeader>
  )

  const treeBody = (): React.JSX.Element => {
    if (rootError) {
      return (
        <PaneNotice data-testid="files-root-failure">
          <PaneNoticeTitle>Can’t read this folder</PaneNoticeTitle>
          <PaneNoticeHint>{rootError}</PaneNoticeHint>
          <NoticeAction onClick={refreshTree}>
            Try again
          </NoticeAction>
        </PaneNotice>
      )
    }
    if (rows.length === 0) {
      // An empty listing IS a loaded map entry — `has` distinguishes "read,
      // nothing there" from "not read yet", which array length can't.
      const loaded = children.has(root)
      const filtered = split.split && filter.trim().length > 0
      return (
        <PaneNotice data-testid={loaded ? 'files-empty-tree' : 'files-tree-loading'}>
          <PaneNoticeTitle>{filtered ? 'No matching files' : loaded ? 'Nothing to show' : 'Reading…'}</PaneNoticeTitle>
          {loaded && (
            <PaneNoticeHint>
              {filtered ? 'Try a different filename or clear the filter.' : 'This folder has no files, or everything in it is build output.'}
            </PaneNoticeHint>
          )}
        </PaneNotice>
      )
    }
    return (
      <TreeScroll
        role="tree"
        aria-label="Workspace files"
        data-testid="files-tree"
      >
        {rows.map((row, i) => (
          <TreeNodeRow
            key={row.path}
            row={row}
            panelSplit={split.split}
            status={gitTreeStatus(root, row.path, row.dir, gitFiles)}
            onDragStart={(event) => {
              try { fileReference(row.path, row.dir); event.dataTransfer.setData(FILE_REFERENCE_MIME, JSON.stringify({ path: row.path, directory: row.dir })); event.dataTransfer.effectAllowed = "copy" }
              catch (error) { event.preventDefault(); reportError(String(error)) }
            }}
            selected={row.path === fileTabs.activePath}
            tabIndex={i === focusIndex ? 0 : -1}
            failure={dirErrors.get(row.path) ?? null}
            registerRef={(el) => {
              if (el) rowRefs.current.set(row.path, el)
              else rowRefs.current.delete(row.path)
            }}
            onActivate={() => {
              setFocusIndex(i)
              if (row.dir) (row.expanded ? collapseDir : expandDir)(row.path)
              else fileTabs.previewFile(row.path)
            }}
            onActivateDouble={() => {
              if (!row.dir) {
                setFocusIndex(i)
                fileTabs.pinFile(row.path)
              }
            }}
            onKeyDown={(e) => onTreeKeyDown(e, i)}
            onContextMenu={(e) => {
              e.preventDefault()
              setFocusIndex(i)
              setMenu({ x: e.clientX, y: e.clientY, path: row.path, dir: row.dir })
            }}
          />
        ))}
      </TreeScroll>
    )
  }




  return (
    <section
      ref={split.containerRef}
      data-split={split.split}
      onKeyDownCapture={(event) => {
        if (split.split && filesTreeToggleMatches(event.nativeEvent, keymapOverrides)) {
          event.preventDefault()
          event.stopPropagation()
          split.toggle()
        }
      }}
      data-pane-focus-border={focusTier}
      className={`pane files-pane ${panel ? "files-panel" : ""} flex-1 min-w-0 min-h-0 relative flex flex-col bg-[var(--pane-bg)] overflow-hidden [@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)] ${active ? 'focus' : ''}`}
      data-panekey={node.id}
      data-testid="files-pane"
    >
      {!panel && header}
      <ExplorerColumns>
        <FilesTreeColumn split={split} rootName={rootName} filter={filter} onFilter={setFilter} treeOpen={treeOpen} onCreate={() => setMutation({ kind: 'file', path: root, name: '' })} onCollapseAll={() => setExpandedDirs(new Set())} onContextMenu={(x, y) => setMenu({ x, y, path: root, dir: true })}>{treeBody()}</FilesTreeColumn>
        {split.split && !split.collapsed && <FilesTreeSash width={split.width} onResize={split.resize} onReset={split.reset} />}
        <FilesEditorColumn panel={panel} split={split} fileTabs={fileTabs} root={root} workspaceDir={workspaceDir} gitFiles={gitFiles} tabsOverflow={tabsOverflow} tabScrollRef={tabScrollRef} tabRefs={tabRefs} onMoveToEditor={onMoveToEditor} onTabMenu={(x, y, path) => setTabMenu({ x, y, path })} onOverflowMenu={(x, y) => setOverflowMenu({ x, y })} revealInTree={revealInTree} reportError={reportError} />
      </ExplorerColumns>
      <FilesTreeContextMenu menu={menu} menuRef={menuRef} root={root} onClose={() => setMenu(null)} onError={reportError} onSendToTerminal={onSendToTerminal} sendToTerminalLabel={sendToTerminalLabel} onRename={(path) => setMutation({ kind: 'rename', path, name: basename(path) })} onDelete={(path) => void removeEntry(path)} onCreate={(kind, path) => setMutation({ kind, path, name: '' })} />
      <MenuLayer open={tabMenu !== null} onClose={() => setTabMenu(null)} suppress="popover" menuRef={tabMenuRef}>
        <FileTabContextMenu
          menuRef={tabMenuRef}
          tabMenu={tabMenu}
          onClose={() => setTabMenu(null)}
          onCloseTab={fileTabs.requestCloseTab}
          onCloseOthers={fileTabs.closeOthers}
          onCloseToRight={fileTabs.closeToRight}
          onCloseSaved={fileTabs.closeSaved}
          onRevealInTree={revealInTree}
          onError={reportError}
        />
      </MenuLayer>
      <MenuLayer open={overflowMenu !== null} onClose={() => setOverflowMenu(null)} suppress="popover" menuRef={overflowMenuRef}>
        <FileTabOverflowMenu
          menuRef={overflowMenuRef}
          overflowMenu={overflowMenu}
          workspaceDir={workspaceDir}
          overflowTabs={overflowTabs}
          onPick={(path) => {
            setOverflowMenu(null)
            fileTabs.setActivePath(path)
          }}
        />
      </MenuLayer>
      {mutation && <FileMutationForm mutation={mutation} onChange={setMutation} onSubmit={() => void applyMutation()} />}

      <AnimOut open={fileTabs.confirmClose !== null} suppress="modal">
        {fileTabs.confirmClose && (
          <SaveDiscardModal
            saving={fileTabs.closeSaving}
            onCancel={fileTabs.cancelCloseTab}
            onDiscard={fileTabs.discardAndClose}
            onSave={() => fileTabs.saveAndClose(reportError)}
          />
        )}
      </AnimOut>
    </section>
  )
}

function FilesTreeContextMenu({ menu, menuRef, root, onClose, onError, onSendToTerminal, sendToTerminalLabel, onRename, onDelete, onCreate }: {
  menu: { x: number; y: number; path: string; dir: boolean } | null
  menuRef: React.RefObject<HTMLDivElement | null>
  root: string
  onClose: () => void
  onError: (message: string) => void
  onSendToTerminal?: (text: string) => void
  sendToTerminalLabel: string
  onRename: (path: string) => void
  onDelete: (path: string) => void
  onCreate: (kind: 'file' | 'directory', path: string) => void
}): React.JSX.Element {
  return (
    <MenuLayer open={menu !== null} onClose={onClose} suppress="popover" menuRef={menuRef}>
      {menu && (
        <ExplorerMenu
          ref={menuRef}
          size="tree"
          data-testid="files-row-menu"
          style={(() => {
            const left = Math.min(menu.x, window.innerWidth - 200)
            const top = Math.max(8, Math.min(menu.y, window.innerHeight - 220))
            return { left, top, ...popOriginStyle(`${menu.x - left}px`, `${menu.y - top}px`) }
          })()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <OpenInMenu path={menu.path} label={menu.dir ? 'Open folder in' : 'Open in'} itemComponent={ExplorerMenuItem} onDone={onClose} onError={onError} />
          <MenuItem onClick={() => { onClose(); copyFilePath(menu.path, onError) }}>Copy path</MenuItem>
          <MenuItem onClick={() => { onClose(); copyFilePath(relativeFilePath(root, menu.path), onError) }}>Copy relative path</MenuItem>
          <MenuItem aria-label={`Send path to ${sendToTerminalLabel}`} disabled={!onSendToTerminal} disabledReason="Focus a live agent pane first" onClick={() => { onSendToTerminal!(menu.path); onClose() }}>{`Send path to ${sendToTerminalLabel}`}</MenuItem>
          <ExplorerMenuSeparator />
          <MenuItem shortcut="F2" onClick={() => { onRename(menu.path); onClose() }}>Rename</MenuItem>
          <MenuItem shortcut="Del" onClick={() => { onDelete(menu.path); onClose() }}>Delete</MenuItem>
          <ExplorerMenuSeparator />
          <ExplorerMenuItem onClick={() => { onCreate('file', fileActionDirectory(menu.path, menu.dir)); onClose() }}>New file</ExplorerMenuItem>
          <ExplorerMenuItem onClick={() => { onCreate('directory', fileActionDirectory(menu.path, menu.dir)); onClose() }}>New folder</ExplorerMenuItem>
          <ExplorerMenuItem onClick={() => {
            const target = fileActionDirectory(menu.path, menu.dir)
            onClose()
            void showItemInFolder(target).then((res) => { if (!res.ok) onError(res.error ?? `could not reveal ${target}`) })
          }}>Reveal in file manager</ExplorerMenuItem>
        </ExplorerMenu>
      )}
    </MenuLayer>
  )
}

function TreeNodeRow({
  panelSplit,
  status,
  onDragStart,
  row,
  selected,
  tabIndex,
  failure,
  registerRef,
  onActivate,
  onActivateDouble,
  onKeyDown,
  onContextMenu
}: {
  panelSplit: boolean
  status: GitFileStatus["status"] | null
  onDragStart: (event: React.DragEvent) => void
  row: TreeRow
  selected: boolean
  tabIndex: number
  failure: string | null
  registerRef: (el: HTMLButtonElement | null) => void
  onActivate: () => void
  onActivateDouble: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const icon = classifyFileTreeEntry(row.name, row.dir, row.expanded)
  return (
    <Tooltip label={failure ? `${row.path} — ${failure}` : row.path} className="flex w-full">
      <TreeItemButton
        ref={registerRef}
        depth={row.depth}
        split={panelSplit}
        selected={selected}
        failed={Boolean(failure)}
        draggable
        onDragStart={onDragStart}
        data-git-status={status ?? undefined}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={row.dir ? row.expanded : undefined}
        aria-level={row.depth + 1}
        tabIndex={tabIndex}
        data-testid="files-tree-row"
        data-path={row.path}
        onClick={onActivate}
        onDoubleClick={onActivateDouble}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      >
        <TreeToggleSlot>
          {row.dir &&
            (row.expanded ? (
              <Icon glyph={IconChevronDown} role="label" />
            ) : (
              <Icon glyph={IconChevronRight} role="label" />
            ))}
        </TreeToggleSlot>
        <FileTreeIcon kind={icon} role="ui" />
        <TreeRowLabel>{row.name}</TreeRowLabel>
        {status && <TreeRowStatus tone={status === 'conflicted' || status === 'deleted' ? 'danger' : status === 'added' ? 'added' : 'changed'}>{status === 'untracked' ? '?' : status[0].toUpperCase()}</TreeRowStatus>}
      </TreeItemButton>
    </Tooltip>
  )
}

function FileTabStrip({
  panelSplit,
  gitFiles,
  root,
  showTree,
  onMove,
  tabs,
  activePath,
  workspaceDir,
  overflowing,
  tabScrollRef,
  tabRefs,
  labelFor,
  onActivate,
  onClose,
  onContextMenu,
  onOpenOverflow
}: {
  panelSplit: boolean
  gitFiles: GitFileStatus[]
  root: string
  showTree?: () => void
  onMove?: () => void
  tabs: FileTab[]
  activePath: string | null
  workspaceDir: string
  overflowing: boolean
  tabScrollRef: React.RefObject<HTMLDivElement | null>
  tabRefs: React.RefObject<Map<string, HTMLDivElement>>
  labelFor: (path: string) => string
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onContextMenu: (x: number, y: number, path: string) => void
  onOpenOverflow: (x: number, y: number) => void
}): React.JSX.Element | null {
  if (tabs.length === 0 && !panelSplit) return null
  return (
    <TabStrip
      split={panelSplit}
      role="tablist"
      aria-label="Open files"
      data-testid="files-tab-strip"
    >
      {panelSplit && showTree && <SplitIconButton label="Show tree" onClick={showTree} glyph={IconPanelLeft} />}
      <TabScroll
        ref={tabScrollRef}
        data-testid="files-tab-scroll"
      >
        {tabs.map((t) => {
          const p = t.path
          const buf = getBuffer(workspaceDir, p)
          const isActive = p === activePath
          return (
            <Tooltip key={p} label={p}>
              <TabItem
                split={panelSplit}
                active={isActive}
                preview={t.preview}
                ref={(el) => {
                  if (el) tabRefs.current.set(p, el)
                  else tabRefs.current.delete(p)
                }}
                role="tab"
                aria-selected={isActive}
                data-testid="files-tab"
                data-path={p}
                onMouseDown={(event) => { if (event.button === 0) onActivate(p) }}
                onAuxClick={(e) => {
                  // onClick never fires for the middle button; auxclick does.
                  if (e.button === 1) onClose(p)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onContextMenu(e.clientX, e.clientY, p)
                }}
              >
                <TabLabel>{labelFor(p)}</TabLabel>
                {panelSplit && <FilesTabStatus status={gitTreeStatus(root, p, false, gitFiles)} />}
                <TabCloseButton
                  aria-label={`Close ${basename(p)}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(p)
                  }}
                >
                  {buf?.dirty ? <UnsavedDot aria-label="Unsaved changes" /> : <Icon glyph={IconClose} role="label" />}
                </TabCloseButton>
              </TabItem>
            </Tooltip>
          )
        })}
      </TabScroll>
      {panelSplit && onMove && <SplitIconButton label="Open in editor pane" onClick={onMove} glyph={IconArrowUpRight} />}
      {overflowing && (
        <Tooltip label="More open files">
          <TabOverflowButton
            type="button"
            aria-label="More open files"
            aria-haspopup="menu"
            data-testid="files-tab-overflow"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              onOpenOverflow(rect.right, rect.bottom + 4)
            }}
          >
            <Icon glyph={IconChevronDown} role="ui" />
          </TabOverflowButton>
        </Tooltip>
      )}
    </TabStrip>
  )
}

function FileTabContextMenu({
  menuRef,
  tabMenu,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseToRight,
  onCloseSaved,
  onRevealInTree,
  onError
}: {
  menuRef: React.RefObject<HTMLDivElement | null>
  tabMenu: { x: number; y: number; path: string } | null
  onClose: () => void
  onCloseTab: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseToRight: (path: string) => void
  onCloseSaved: () => void
  onRevealInTree: (path: string) => void
  onError: (message: string) => void
}): React.JSX.Element | null {
  if (!tabMenu) return null
  const path = tabMenu.path
  const act = (fn: () => void) => (): void => {
    onClose()
    fn()
  }
  return (
    <ExplorerMenu
      ref={menuRef}
      size="tab"
      data-testid="files-tab-menu"
      style={(() => {
        const left = Math.min(tabMenu.x, window.innerWidth - 200)
        const top = Math.max(8, Math.min(tabMenu.y, window.innerHeight - 160))
        return { left, top, ...popOriginStyle(`${tabMenu.x - left}px`, `${tabMenu.y - top}px`) }
      })()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ExplorerMenuItem onClick={act(() => onCloseTab(path))}>
        Close
      </ExplorerMenuItem>
      <ExplorerMenuItem onClick={act(() => onCloseOthers(path))}>
        Close others
      </ExplorerMenuItem>
      <ExplorerMenuItem onClick={act(() => onCloseToRight(path))}>
        Close to the right
      </ExplorerMenuItem>
      <ExplorerMenuItem onClick={act(onCloseSaved)}>
        Close saved
      </ExplorerMenuItem>
      <ExplorerMenuSeparator />
      <ExplorerMenuItem
        onClick={act(() => {
          void navigator.clipboard?.writeText(path).catch((e: unknown) => onError(String((e as Error)?.message ?? e)))
        })}
      >
        Copy path
      </ExplorerMenuItem>
      <ExplorerMenuItem onClick={act(() => onRevealInTree(path))}>
        Reveal in tree
      </ExplorerMenuItem>
    </ExplorerMenu>
  )
}

function FileTabOverflowMenu({
  menuRef,
  overflowMenu,
  workspaceDir,
  overflowTabs,
  onPick
}: {
  menuRef: React.RefObject<HTMLDivElement | null>
  overflowMenu: { x: number; y: number } | null
  workspaceDir: string
  overflowTabs: () => FileTab[]
  onPick: (path: string) => void
}): React.JSX.Element | null {
  if (!overflowMenu) return null
  const off = overflowTabs()
  return (
    <ExplorerMenu
      ref={menuRef}
      size="overflow"
      data-testid="files-tab-overflow-menu"
      style={(() => {
        const left = Math.min(overflowMenu.x - 220, window.innerWidth - 228)
        const top = Math.max(8, Math.min(overflowMenu.y, window.innerHeight - 8))
        return { left, top, ...popOriginStyle('100%', '0px') }
      })()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ExplorerMenuCaption>
        {off.length} more open
      </ExplorerMenuCaption>
      {off.map((t) => (
        <ExplorerMenuItem
          key={t.path}
          rich
          onClick={() => onPick(t.path)}
        >
          {getBuffer(workspaceDir, t.path)?.dirty && <UnsavedDot aria-label="Unsaved changes" />}
          <TabLabel leftAligned>{basename(t.path)}</TabLabel>
          <TreeRowStatus tone="faint" className="flex-none">
            {basename(parentDir(t.path))}
          </TreeRowStatus>
        </ExplorerMenuItem>
      ))}
    </ExplorerMenu>
  )
}

function parentDir(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

function ancestorDirs(root: string, path: string): string[] {
  const out: string[] = []
  let dir = parentDir(path)
  while (dir.length > root.length && dir.startsWith(root)) {
    out.unshift(dir)
    dir = parentDir(dir)
  }
  return out
}

type FileMutation = { kind: 'file' | 'directory' | 'rename'; path: string; name: string }

function FileMutationForm({ mutation, onChange, onSubmit }: {
  mutation: FileMutation
  onChange: (value: FileMutation | null) => void
  onSubmit: () => void
}): React.JSX.Element {
  const renaming = mutation.kind === 'rename'
  return <NameForm aria-label={`${renaming ? 'Rename' : 'Create in'} ${mutation.path}`} onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
    <NameInput autoFocus aria-label="Filename" value={mutation.name} onChange={(event) => onChange({ ...mutation, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onChange(null) } }} />
    <PlainButton type="submit">{renaming ? 'Rename' : 'Create'}</PlainButton>
    <PlainButton type="button" onClick={() => onChange(null)}>Cancel</PlainButton>
  </NameForm>
}

function FileHeaderActions({ panel, path, onCreate, onMove, onClose }: {
  root: string
  panel?: boolean
  path: string | null
  onCreate: () => void
  onMove?: (path: string) => void
  onClose: (path: string) => void
}): React.JSX.Element {
  return <>
    <Tooltip label="New file"><PlainButton aria-label="New file" onClick={onCreate}>New file</PlainButton></Tooltip>
    {panel && path && onMove && <PlainButton onClick={() => { onMove(path); onClose(path) }}>Open in editor pane</PlainButton>}
  </>
}

function fileLineEnding(buffer: ReturnType<typeof getBuffer>): string {
  return buffer?.lineEnding ?? 'LF'
}

function FilesEditorHeader({ panel, path, onMove, onClose, tabs }: { panel?: boolean; path: string | null; onMove?: (path: string) => void; onClose: (path: string) => void; tabs: React.ReactNode }): React.JSX.Element {
  if (!panel) return <>{tabs}</>
  if (!path) return <></>
  return <ViewerHead><span className="truncate flex-1">{path}</span><Tooltip label="Open in editor pane"><ViewerOpenButton aria-label="Open in editor pane" onClick={() => { onMove?.(path); onClose(path) }}><Icon glyph={IconArrowUpRight} role="label" /></ViewerOpenButton></Tooltip></ViewerHead>
}

function FilesTreeHeader({ rootName, filter, onFilter, onCreate, onCollapseAll, onCollapse }: {
  rootName: string; filter: string; onFilter: (value: string) => void; onCreate: () => void; onCollapseAll: () => void; onCollapse: () => void
}): React.JSX.Element {
  return <>
    <TreeHead>
      <span className="truncate flex-1">{rootName}</span>
      <SplitIconButton label="New file" onClick={onCreate} glyph={IconPlus} />
      <SplitIconButton label="Collapse all" onClick={onCollapseAll} glyph={IconMinimize} />
      <SplitIconButton label="Collapse tree" onClick={onCollapse} glyph={IconChevronLeft} />
    </TreeHead>
    <TreeFilter><Icon glyph={IconSearch} role="label" /><TreeFilterInput aria-label="Filter files" placeholder="Filter files" value={filter} onChange={(event) => onFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onFilter('') } }} /></TreeFilter>
  </>
}

function FilesTreeSash({ width, onResize, onReset }: { width: number; onResize: (width: number) => void; onReset: () => void }): React.JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  return <TreeSash role="separator" aria-label="Resize file tree" aria-orientation="vertical" aria-valuemin={FILES_TREE_MIN} aria-valuemax={FILES_TREE_MAX} aria-valuenow={width} tabIndex={0} data-dragging={dragging} onDoubleClick={onReset}
    onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onResize(width + (event.key === 'ArrowRight' ? 10 : -10)) } }}
    onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true) }}
    onPointerMove={(event) => { if (drag.current) onResize(drag.current.width + event.clientX - drag.current.x) }}
    onPointerUp={() => { drag.current = null; setDragging(false) }} onLostPointerCapture={() => { drag.current = null; setDragging(false) }} />
}

function FilesBreadcrumb({ root, path, onReveal }: { root: string; path: string; onReveal: (path: string) => void }): React.JSX.Element {
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  const segments = relative.split('/').filter(Boolean)
  return <Breadcrumb aria-label="File breadcrumb" compact>
    {segments.map((segment, index) => <BreadcrumbSegment key={index}>
      {index > 0 && <Icon glyph={IconChevronRight} role="label" />}
      {index === segments.length - 1 ? <BreadcrumbCurrent>{segment}</BreadcrumbCurrent> : <BreadcrumbLink onClick={() => onReveal(`${root}/${segments.slice(0, index + 1).join('/')}`)}>{segment}</BreadcrumbLink>}
    </BreadcrumbSegment>)}
  </Breadcrumb>
}

function FilesTabStatus({ status }: { status: GitFileStatus['status'] | null }): React.JSX.Element | null {
  if (!status) return null
  const added = status === 'added' || status === 'untracked'
  return <TabGitMark added={added} small>{added ? 'A' : status[0].toUpperCase()}</TabGitMark>
}

function FilesEditorColumn({ panel, split, fileTabs, root, workspaceDir, gitFiles, tabsOverflow, tabScrollRef, tabRefs, onMoveToEditor, onTabMenu, onOverflowMenu, revealInTree, reportError }: {
  panel?: boolean
  split: ReturnType<typeof useFilesSplit>
  fileTabs: FileTabsState
  root: string
  workspaceDir: string
  gitFiles: GitFileStatus[]
  tabsOverflow: boolean
  tabScrollRef: React.RefObject<HTMLDivElement | null>
  tabRefs: React.RefObject<Map<string, HTMLDivElement>>
  onMoveToEditor?: (path: string) => void
  onTabMenu: (x: number, y: number, path: string) => void
  onOverflowMenu: (x: number, y: number) => void
  revealInTree: (path: string) => void
  reportError: (message: string) => void
}): React.JSX.Element {
  return (
    <EditorColumn>
      <FilesEditorHeader panel={panel && !split.split} path={fileTabs.activePath} onMove={onMoveToEditor} onClose={fileTabs.transferTab} tabs={<FileTabStrip
        panelSplit={split.split}
        gitFiles={gitFiles}
        root={root}
        showTree={split.collapsed ? split.toggle : undefined}
        onMove={fileTabs.activePath && onMoveToEditor ? () => { onMoveToEditor(fileTabs.activePath!); fileTabs.transferTab(fileTabs.activePath!) } : undefined}
        tabs={fileTabs.tabs}
        activePath={fileTabs.activePath}
        workspaceDir={workspaceDir}
        overflowing={tabsOverflow}
        tabScrollRef={tabScrollRef}
        tabRefs={tabRefs}
        labelFor={fileTabs.labelFor}
        onActivate={fileTabs.setActivePath}
        onClose={fileTabs.requestCloseTab}
        onContextMenu={onTabMenu}
        onOpenOverflow={onOverflowMenu}
      />} />
      {split.split && fileTabs.activePath && <FilesBreadcrumb root={root} path={fileTabs.activePath} onReveal={revealInTree} />}
      {fileTabs.tabError && <TabError role="alert">{fileTabs.tabError}</TabError>}
      {fileTabs.activePath ? (
        <>
          <Suspense fallback={<div className="flex-1 min-w-0 min-h-0 relative overflow-hidden" />}>
            <EditorSurfaceBody
              surface={fileTabs.surface}
              extraMenuItems={
                <>
                  <ExplorerMenuSeparator />
                  <OpenInMenu
                    path={fileTabs.activePath}
                    itemComponent={ExplorerMenuItem}
                    onDone={() => fileTabs.surface.setCmMenu(null)}
                    onError={reportError}
                  />
                </>
              }
            />
          </Suspense>
          <StatusStrip split={split.split} data-testid="files-status-strip">
            <StatusCell>{fileTabs.langLabel}</StatusCell>
            <FilesWordWrapToggle fileTabs={fileTabs} workspaceDir={workspaceDir} />
            <StatusCell mono end data-testid="files-caret">
              {fileTabs.caret ?? ''}
            </StatusCell>
            {/* Facts about the file, not choices: every read is UTF-8, and the
                line ending is what the buffer recorded at load. */}
            <StatusCell mono>{fileLineEnding(fileTabs.activeBuf)}</StatusCell>
            <StatusCell mono>UTF-8</StatusCell>
          </StatusStrip>
        </>
      ) : (
        <PaneNotice data-testid="files-no-file">
          <PaneNoticeTitle>No file open</PaneNoticeTitle>
          <PaneNoticeHint>Pick one from the tree to edit it here.</PaneNoticeHint>
        </PaneNotice>
      )}
    </EditorColumn>
  )
}

function FilesWordWrapToggle({ fileTabs, workspaceDir }: { fileTabs: FileTabsState; workspaceDir: string }): React.JSX.Element {
  const buffer = fileTabs.activeBuf
  return (
    <Tooltip label="Toggle word wrap">
      <Button
        size="sm"
        variant="ghost"
        aria-label="Word wrap"
        aria-pressed={Boolean(buffer?.wrap)}
        disabled={!buffer}
        data-testid="files-word-wrap"
        onClick={() => {
          void import('../editor/buffers').then(({ setBufferWrap }) =>
            setBufferWrap(workspaceDir, fileTabs.activePath!, !buffer!.wrap)
          )
        }}
      >
        Wrap
      </Button>
    </Tooltip>
  )
}

function FilesTreeColumn({ split, rootName, filter, onFilter, treeOpen, onCreate, onCollapseAll, onContextMenu, children }: {
  split: ReturnType<typeof useFilesSplit>
  rootName: string
  filter: string
  onFilter: (filter: string) => void
  treeOpen: boolean
  onCreate: () => void
  onCollapseAll: () => void
  onContextMenu: (x: number, y: number) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TreeColumn
      open={treeOpen}
      data-testid="files-tree-column"
      style={split.split ? { width: split.width, display: split.collapsed ? 'none' : 'flex' } : undefined}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('[role="treeitem"]')) return
        event.preventDefault()
        onContextMenu(event.clientX, event.clientY)
      }}
    >
      {split.split && <FilesTreeHeader rootName={rootName} filter={filter} onFilter={onFilter} onCreate={onCreate} onCollapseAll={onCollapseAll} onCollapse={split.toggle} />}
      {children}
    </TreeColumn>
  )
}
