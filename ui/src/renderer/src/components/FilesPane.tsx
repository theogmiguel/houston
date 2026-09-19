import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RING_ACCENT_ICON } from './shadowChrome'
import type { DirEntry } from '../env'
import type { FilesNode, PaneKey } from '../layout/tree'
import { readDir, showItemInFolder } from '../houston/bridge'
import {
  PANE_BORDER_CLS,
  PANE_HEAD_BG_CLS,
  PANE_TITLE_INK_CLS,
  usePaneFocusTier
} from '../windowFocus'
import { basename, getBuffer } from '../editor/bufferStore'
import { SaveIndicator } from '../editor/SaveIndicator'
import {
  ECTX_ITEM_CLS as EDITOR_CTX_ITEM_CLS,
  ECTX_SEP_CLS as EDITOR_CTX_SEP_CLS,
  EDOT_CLS,
  EHOST_WRAP_CLS
} from '../editor/editorChrome'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { HIT_TARGET_28 } from './hitTarget'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { classifyFileTreeEntry, FileTreeIcon } from './fileTreeIcons'
import { flattenTree, treeKeyAction, visibleEntries, type TreeRow } from './files/filesTree'
import { useFileTabs, type FileTab } from './files/useFileTabs'
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconMaximize,
  IconMinimize,
  IconPanelLeft,
  IconRefresh,
  IconSave
} from './icons'
import { Tooltip } from './Tooltip'
import { MarkdownPreviewToggle } from './MarkdownPreview'
import { AnimOut, MenuLayer } from './AnimOut'
import { OpenInMenu } from './OpenInMenu'
import { SaveDiscardModal } from './SaveDiscardModal'
import { Icon } from './Icon'
import { POP_ORIGIN_CLS, popOriginStyle } from './overlayChrome'

const ICO_HEAD_BASE =
  `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] [transition:background_0.16s_cubic-bezier(0.4,0,0.2,1),color_0.16s_ease,transform_0.18s_cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-px active:translate-y-0 active:scale-90 focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none`
const ICO_HEAD_NEUTRAL =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] hover:text-[var(--text-primary)]'
const ICO_HEAD_DANGER =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)]'
const ICO_HEAD_INFO =
  'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'
const PANE_TITLE_CLS =
  'pane-title font-medium tracking-[-0.01em] leading-[1.4] whitespace-nowrap overflow-hidden text-ellipsis min-w-[32px]'

// Dynamic import: CodeMirror plus its grammars has no business loading just
// to show a file tree.
const EditorSurfaceBody = lazy(() =>
  import('./EditorSurface').then((m) => ({ default: m.EditorSurfaceBody }))
)

// 420px is where a 220px tree column plus a readable ~60-column editor line
// still both fit; below it the tree collapses to a toggleable overlay instead.
const TREE_VISIBLE = '[@container_(min-width:420px)]'
const TREE_W = 'w-[220px]'

const ROW_BASE =
  'group/row w-full flex items-center gap-1.5 pr-2 min-h-[var(--h-ctl-mini)] text-left bg-transparent border-none ' +
  'text-[length:var(--tr-text-sm)] text-[var(--text-secondary)] whitespace-nowrap ' +
  'hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] hover:text-[var(--text-primary)] ' +
  'focus-visible:outline-none focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
const ROW_SELECTED = 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'

const TAB_BASE =
  'group/tab flex items-center gap-1.5 pl-2.5 pr-1 h-[var(--h-pill)] flex-none max-w-[180px] ' +
  'border-r border-[color-mix(in_srgb,var(--divider)_55%,transparent)] ' +
  'text-[length:var(--tr-text-sm)] text-[var(--text-muted)] cursor-default select-none ' +
  'hover:text-[var(--text-primary)]'
const TAB_ACTIVE = 'bg-[var(--tool-code-bg)] text-[var(--text-primary)]'
const TAB_PREVIEW = 'italic'

const OVERFLOW_BTN = `${CONTROL_SIZE_SQUARE_CLS.small} ${ICO_HEAD_BASE} ${ICO_HEAD_NEUTRAL} ${HIT_TARGET_28} border-l border-[color-mix(in_srgb,var(--divider)_55%,transparent)]`

const STRIP_CELL = 'px-2 text-[length:var(--tr-text-xs)] text-[var(--text-faint)] whitespace-nowrap'

const NOTICE_BODY =
  'flex-1 min-h-0 flex flex-col items-center justify-center gap-1.5 p-4 text-center'
const NOTICE_TITLE =
  'text-[length:var(--tr-text-sm)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]'
const NOTICE_HINT = 'text-[length:var(--tr-text-xs)] text-[var(--text-muted)] max-w-[36ch] break-all'

export interface FilesPaneProps {
  node: FilesNode
  workspaceDir: string
  onClose: () => void
  onHeaderPointerDown: (e: React.PointerEvent) => void
  active?: boolean
  expanded?: boolean
  onExpand?: (key: PaneKey) => void
  onError?: (message: string) => void
}

export function FilesPane({
  node,
  workspaceDir,
  onClose,
  onHeaderPointerDown,
  active = false,
  expanded = false,
  onExpand,
  onError
}: FilesPaneProps): React.JSX.Element {
  const focusTier = usePaneFocusTier(active)
  const root = node.root ?? workspaceDir

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
    () => flattenTree(root, children, expandedDirs),
    [root, children, expandedDirs]
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
      for (const dir of ancestorDirs(root, path)) expandDir(dir)
      const idx = rows.findIndex((r) => r.path === path)
      if (idx !== -1) {
        pullFocusRef.current = true
        setFocusIndex(idx)
      }
    },
    [root, expandDir, rows]
  )

  useEffect(() => {
    if (!pullFocusRef.current) return
    pullFocusRef.current = false
    const row = rows[focusIndex]
    if (row) rowRefs.current.get(row.path)?.focus()
  })

  const onTreeKeyDown = (e: React.KeyboardEvent, index: number): void => {
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
    <header
      className={`group pane-head touch-none flex items-center gap-2 pr-1 pl-[var(--space-2-5)] h-[var(--h-pane-head)] min-h-[var(--h-pane-head)] border-b border-b-[color-mix(in_srgb,var(--divider)_55%,transparent)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tracking-[-0.005em] text-[var(--text-primary)] flex-none cursor-grab active:cursor-grabbing [transition:background_0.2s,border-color_0.2s] @container ${PANE_HEAD_BG_CLS[focusTier]}`}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        onHeaderPointerDown(e)
      }}
    >
      <span className="flex-none text-[var(--text-muted)]">
        <Icon glyph={IconFolder} role="ui" />
      </span>
      <span className={`${PANE_TITLE_CLS} ${PANE_TITLE_INK_CLS}`}>Files</span>
      <Tooltip label={root}>
        <span
          data-testid="files-head-meta"
          className="flex-none font-mono text-[length:var(--tr-text-xs)] text-[var(--text-faint)] whitespace-nowrap overflow-hidden text-ellipsis [@container_(max-width:320px)]:hidden"
        >
          {rootName}
        </span>
      </Tooltip>
      <span className="head-actions flex items-center gap-px flex-none ml-auto">
        {}
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
    </header>
  )

  const treeBody = (): React.JSX.Element => {
    if (rootError) {
      return (
        <div className={NOTICE_BODY} data-testid="files-root-failure">
          <div className={NOTICE_TITLE}>Can’t read this folder</div>
          <div className={NOTICE_HINT}>{rootError}</div>
          <button
            className={`btn ${ROW_BASE} justify-center pl-2 rounded-[var(--tr-radius-sm)]`}
            onClick={refreshTree}
          >
            Try again
          </button>
        </div>
      )
    }
    if (rows.length === 0) {
      // An empty listing IS a loaded map entry — `has` distinguishes "read,
      // nothing there" from "not read yet", which array length can't.
      const loaded = children.has(root)
      return (
        <div className={NOTICE_BODY} data-testid={loaded ? 'files-empty-tree' : 'files-tree-loading'}>
          <div className={NOTICE_TITLE}>{loaded ? 'Nothing to show' : 'Reading…'}</div>
          {loaded && (
            <div className={NOTICE_HINT}>
              This folder has no files, or everything in it is build output.
            </div>
          )}
        </div>
      )
    }
    return (
      <div
        role="tree"
        aria-label="Workspace files"
        data-testid="files-tree"
        className="flex-1 min-h-0 overflow-auto py-1 [scrollbar-width:thin]"
      >
        {rows.map((row, i) => (
          <TreeNodeRow
            key={row.path}
            row={row}
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
      </div>
    )
  }

  const treeColumn = (
    <aside
      data-testid="files-tree-column"
      className={`${TREE_W} flex-none flex flex-col min-h-0 border-r border-[color-mix(in_srgb,var(--divider)_55%,transparent)] ${
        treeOpen ? 'flex' : `hidden ${TREE_VISIBLE}:flex`
      }`}
    >
      {treeBody()}
    </aside>
  )

  const editorColumn = (
    <div className="editor-leaf flex-1 min-w-0 min-h-0 flex flex-col bg-[var(--tool-code-bg)]">
      <FileTabStrip
        tabs={fileTabs.tabs}
        activePath={fileTabs.activePath}
        workspaceDir={workspaceDir}
        overflowing={tabsOverflow}
        tabScrollRef={tabScrollRef}
        tabRefs={tabRefs}
        labelFor={fileTabs.labelFor}
        onActivate={fileTabs.setActivePath}
        onClose={fileTabs.requestCloseTab}
        onContextMenu={(x, y, path) => setTabMenu({ x, y, path })}
        onOpenOverflow={(x, y) => setOverflowMenu({ x, y })}
      />
      {fileTabs.activePath ? (
        <>
          <Suspense fallback={<div className={EHOST_WRAP_CLS} />}>
            <EditorSurfaceBody
              surface={fileTabs.surface}
              extraMenuItems={
                <>
                  <div className={EDITOR_CTX_SEP_CLS} />
                  <OpenInMenu
                    path={fileTabs.activePath}
                    itemClass={EDITOR_CTX_ITEM_CLS}
                    onDone={() => fileTabs.surface.setCmMenu(null)}
                    onError={reportError}
                  />
                </>
              }
            />
          </Suspense>
          <div
            data-testid="files-status-strip"
            className="flex-none flex items-center h-[20px] border-t border-[color-mix(in_srgb,var(--divider)_55%,transparent)] bg-[color-mix(in_srgb,var(--card-bg)_45%,transparent)]"
          >
            <span className={STRIP_CELL}>{fileTabs.langLabel}</span>
            <span className={`${STRIP_CELL} ml-auto font-mono`} data-testid="files-caret">
              {fileTabs.caret ?? ''}
            </span>
            {/* Facts about the file, not choices: every read is UTF-8, and the
                line ending is what the buffer recorded at load. */}
            <span className={`${STRIP_CELL} font-mono`}>{fileTabs.activeBuf?.lineEnding ?? 'LF'}</span>
            <span className={`${STRIP_CELL} font-mono`}>UTF-8</span>
          </div>
        </>
      ) : (
        <div className={NOTICE_BODY} data-testid="files-no-file">
          <div className={NOTICE_TITLE}>No file open</div>
          <div className={NOTICE_HINT}>Pick one from the tree to edit it here.</div>
        </div>
      )}
    </div>
  )

  return (
    <section
      className={`pane files-pane flex-1 min-w-0 min-h-0 relative flex flex-col border ${PANE_BORDER_CLS[focusTier]} bg-[var(--pane-bg)] overflow-hidden rounded-[var(--tr-radius-md)] [@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)] ${active ? 'focus' : ''}`}
      data-panekey={node.id}
      data-testid="files-pane"
    >
      {header}
      <div className="flex-1 min-h-0 flex">
        {treeColumn}
        {editorColumn}
      </div>
      <MenuLayer open={menu !== null} onClose={() => setMenu(null)} suppress="popover" menuRef={menuRef}>
        {menu && (
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            data-testid="files-row-menu"
            className={`ctx-menu fixed z-[var(--z-overlay)] min-w-[180px] flex flex-col p-1 bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] ${POP_ORIGIN_CLS}`}
            style={(() => {
              const left = Math.min(menu.x, window.innerWidth - 200)
              const top = Math.max(8, Math.min(menu.y, window.innerHeight - 160))
              return { left, top, ...popOriginStyle(`${menu.x - left}px`, `${menu.y - top}px`) }
            })()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <OpenInMenu
              path={menu.path}
              label={menu.dir ? 'Open folder in' : 'Open in'}
              itemClass={EDITOR_CTX_ITEM_CLS}
              onDone={() => setMenu(null)}
              onError={reportError}
            />
            <button
              className={`btn border-none ${EDITOR_CTX_ITEM_CLS}`}
              role="menuitem"
              onClick={() => {
                const target = menu.dir ? menu.path : parentDir(menu.path)
                setMenu(null)
                void showItemInFolder(target).then((res) => {
                  if (!res.ok) reportError(res.error ?? `could not reveal ${target}`)
                })
              }}
            >
              Reveal in file manager
            </button>
            <button
              className={`btn border-none ${EDITOR_CTX_ITEM_CLS}`}
              role="menuitem"
              onClick={() => {
                const p = menu.path
                setMenu(null)
                void navigator.clipboard
                  ?.writeText(p)
                  .catch((e: unknown) => reportError(String((e as Error)?.message ?? e)))
              }}
            >
              Copy path
            </button>
          </div>
        )}
      </MenuLayer>
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

function TreeNodeRow({
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
      <button
        ref={registerRef}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={row.dir ? row.expanded : undefined}
        aria-level={row.depth + 1}
        tabIndex={tabIndex}
        data-testid="files-tree-row"
        data-path={row.path}
        className={`${ROW_BASE} ${selected ? ROW_SELECTED : ''} ${failure ? 'text-[var(--danger)]' : ''}`}
        style={{ paddingLeft: 6 + row.depth * 12 }}
        onClick={onActivate}
        onDoubleClick={onActivateDouble}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      >
        <span className="w-3 flex-none inline-flex items-center justify-center text-[var(--text-faint)]">
          {row.dir &&
            (row.expanded ? (
              <Icon glyph={IconChevronDown} role="label" />
            ) : (
              <Icon glyph={IconChevronRight} role="label" />
            ))}
        </span>
        <FileTreeIcon kind={icon} role="ui" />
        <span className="flex-1 min-w-0 overflow-hidden text-ellipsis">{row.name}</span>
      </button>
    </Tooltip>
  )
}

function FileTabStrip({
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
  if (tabs.length === 0) return null
  return (
    <div
      role="tablist"
      aria-label="Open files"
      data-testid="files-tab-strip"
      className="flex-none flex items-stretch border-b border-[color-mix(in_srgb,var(--divider)_55%,transparent)] bg-[color-mix(in_srgb,var(--card-bg)_45%,transparent)]"
    >
      <div
        ref={tabScrollRef}
        data-testid="files-tab-scroll"
        className="files-tab-scroll flex-1 min-w-0 flex items-stretch overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((t) => {
          const p = t.path
          const buf = getBuffer(workspaceDir, p)
          const isActive = p === activePath
          return (
            <Tooltip key={p} label={p}>
              <div
                ref={(el) => {
                  if (el) tabRefs.current.set(p, el)
                  else tabRefs.current.delete(p)
                }}
                role="tab"
                aria-selected={isActive}
                data-testid="files-tab"
                data-path={p}
                className={`${TAB_BASE} ${isActive ? TAB_ACTIVE : ''} ${t.preview ? TAB_PREVIEW : ''}`}
                onMouseDown={() => onActivate(p)}
                onAuxClick={(e) => {
                  // onClick never fires for the middle button; auxclick does.
                  if (e.button === 1) onClose(p)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onContextMenu(e.clientX, e.clientY, p)
                }}
              >
                {buf?.dirty && <span className={EDOT_CLS} aria-label="Unsaved changes" />}
                {}
                <span className="flex-1 min-w-0 truncate">{labelFor(p)}</span>
                {}
                <button
                  className={`btn ${BTN_ICO_STRUCTURE} w-[16px] h-[16px] rounded-[var(--tr-radius-sm)] ${ICO_HEAD_DANGER} ${HIT_TARGET_28}`}
                  aria-label={`Close ${basename(p)}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(p)
                  }}
                >
                  <Icon glyph={IconClose} role="label" />
                </button>
              </div>
            </Tooltip>
          )
        })}
      </div>
      {overflowing && (
        <Tooltip label="More open files">
          <button
            type="button"
            aria-label="More open files"
            aria-haspopup="menu"
            data-testid="files-tab-overflow"
            className={`btn ${OVERFLOW_BTN}`}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              onOpenOverflow(rect.right, rect.bottom + 4)
            }}
          >
            <Icon glyph={IconChevronDown} role="ui" />
          </button>
        </Tooltip>
      )}
    </div>
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
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      data-testid="files-tab-menu"
      className={`ctx-menu fixed z-[var(--z-overlay)] min-w-[180px] flex flex-col p-1 bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] ${POP_ORIGIN_CLS}`}
      style={(() => {
        const left = Math.min(tabMenu.x, window.innerWidth - 200)
        const top = Math.max(8, Math.min(tabMenu.y, window.innerHeight - 160))
        return { left, top, ...popOriginStyle(`${tabMenu.x - left}px`, `${tabMenu.y - top}px`) }
      })()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className={`btn border-none ${EDITOR_CTX_ITEM_CLS}`} role="menuitem" onClick={act(() => onCloseTab(path))}>
        Close
      </button>
      <button className={`btn border-none ${EDITOR_CTX_ITEM_CLS}`} role="menuitem" onClick={act(() => onCloseOthers(path))}>
        Close others
      </button>
      <button className={`btn border-none ${EDITOR_CTX_ITEM_CLS}`} role="menuitem" onClick={act(() => onCloseToRight(path))}>
        Close to the right
      </button>
      <button className={`btn border-none ${EDITOR_CTX_ITEM_CLS}`} role="menuitem" onClick={act(onCloseSaved)}>
        Close saved
      </button>
      <div className={EDITOR_CTX_SEP_CLS} />
      <button
        className={`btn border-none ${EDITOR_CTX_ITEM_CLS}`}
        role="menuitem"
        onClick={act(() => {
          void navigator.clipboard?.writeText(path).catch((e: unknown) => onError(String((e as Error)?.message ?? e)))
        })}
      >
        Copy path
      </button>
      <button className={`btn border-none ${EDITOR_CTX_ITEM_CLS}`} role="menuitem" onClick={act(() => onRevealInTree(path))}>
        Reveal in tree
      </button>
    </div>
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
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      data-testid="files-tab-overflow-menu"
      className={`ctx-menu fixed z-[var(--z-overlay)] min-w-[220px] max-w-[280px] flex flex-col p-1 bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] ${POP_ORIGIN_CLS}`}
      style={(() => {
        const left = Math.min(overflowMenu.x - 220, window.innerWidth - 228)
        const top = Math.max(8, Math.min(overflowMenu.y, window.innerHeight - 8))
        return { left, top, ...popOriginStyle('100%', '0px') }
      })()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className={`${EDITOR_CTX_ITEM_CLS} pointer-events-none [font-size:var(--tr-text-label-size)] text-[var(--text-faint)]`}
      >
        {off.length} more open
      </div>
      {off.map((t) => (
        <button
          key={t.path}
          className={`btn border-none flex items-center gap-2 ${EDITOR_CTX_ITEM_CLS}`}
          role="menuitem"
          onClick={() => onPick(t.path)}
        >
          {getBuffer(workspaceDir, t.path)?.dirty && <span className={EDOT_CLS} aria-label="Unsaved changes" />}
          <span className="flex-1 min-w-0 truncate text-left">{basename(t.path)}</span>
          <span className="flex-none font-mono text-[length:var(--tr-text-xs)] text-[var(--text-faint)]">
            {basename(parentDir(t.path))}
          </span>
        </button>
      ))}
    </div>
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
