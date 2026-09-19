import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  GhosttyPaneTerminal,
  ghosttyThemeFromCss,
  type PaneLink,
  type PaneLinkProvider,
  type PaneTerminal
} from './ghosttyTerminal'
import { createGhosttyFinder, type PaneFinder } from './ghosttyFind'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import {
  openExternal,
  pathKind,
  readClipboardImagePath,
  readClipboardText,
  resolveDroppedFile,
  saveImage
} from '../houston/bridge'
import { checkImageSizeCap, dragCarriesFiles, readDropEntries, type DropEntry } from './dropTransfer'
import { decideImeDelivery, emptyImeDedupState, noteCompositionEnd } from './imeDedup'
import { inputTraceEnabled, traceInputEvent } from './inputTrace'
import { TERMINAL_FONT_DEFAULT } from './terminalFonts'
import { shiftEnterSequence } from './shiftEnter'
import { logTerminalTransport } from '../houston/latency'
import { TERMINAL_PALETTES, type ThemeName } from '../theme'
import { ExpandedContext } from '../layout/expandedContext'
import { GridHiddenContext } from '../layout/gridHiddenContext'
import { WarmContext } from '../layout/warmContext'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import {
  fontZoomIn,
  fontZoomOut,
  fontZoomReset,
  endsDictationHold,
  isDictationChord,
  isPasteChord,
  resolveGlobalMatch,
  zoomIn,
  zoomOut,
  zoomReset
} from '../keymap'
import {
  IconArrowDown,
  IconArrowUp,
  IconClose,
  IconFileDown,
  IconImage,
  IconLoaderCircle
} from '../components/icons'
import { BTN_ICO } from '../components/buttonChrome'

const DROPZONE_FILE_ICON = resolveTightGlyph(IconFileDown, 'ui')
import { registerVoiceInsert, registerVoiceNotice } from '../voice/store'
import { abandonDictation, voiceChordDown, voiceChordUp } from '../voice/dictation'
import { SPIN_CLASS } from '../components/git/DiffBody'
import { outputText, stripBoxGlyphs as stripBox } from './copyOutput'
import {
  extractDragRangeText,
  pixelToCell,
  TUI_DRAG_EMPTY_HINT,
  type CellPos,
  type CellRect
} from './tuiDragCopy'
import { shellQuote } from './shellQuote'
import { PaneWriteQueue } from './writeQueue'
import { useNotices } from '../notices'
import { NoticeStack } from '../components/NoticeStack'
import { findUrls, rangesOverlap, joinWrappedLine, mapJoinedOffset } from './webLinks'
import { passKeysToTerminal } from '../paneCaps'
import { ICON_ROLE_CLS, Icon, resolveTightGlyph } from '../components/Icon'
import { Tooltip } from '../components/Tooltip'

export interface TerminalTuning {
  readonly lineHeight: number
  readonly cursorBlink: boolean
  readonly scrollbackLines: number
}
export const TerminalTuningContext = createContext<TerminalTuning>({
  lineHeight: 1.35,
  cursorBlink: true,
  scrollbackLines: 10_000
})

const FILE_TOKEN_RE =
  /(?<path>(?:\.{0,2}\/)?[\w.@/-]*\.\w{1,8}|(?:\/|\.{1,2}\/)[\w@/-]+)(?::(?<line>\d+)(?::(?<col>\d+))?)?/g

// A path's kind rarely flips mid-session, so hovering the same link repeatedly
// must not re-ask the main process every time. Cap 256, drop oldest.
const PATH_KIND_CACHE_CAP = 256
type PathKind = 'file' | 'dir' | null
const pathKindCache = new Map<string, PathKind>()

async function checkPathKind(path: string): Promise<PathKind> {
  const cached = pathKindCache.get(path)
  if (cached !== undefined) return cached
  const kind = await pathKind(path)
  if (pathKindCache.size >= PATH_KIND_CACHE_CAP) {
    const oldest = pathKindCache.keys().next().value
    if (oldest !== undefined) pathKindCache.delete(oldest)
  }
  pathKindCache.set(path, kind)
  return kind
}

function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/\/+$/, '')}/${rel.replace(/^\.\//, '')}`
}

function collapseHome(path: string): string {
  return path.replace(/^\/(home|Users)\/[^/]+/, '~')
}

// Cached rather than called per pane: under StrictMode the mount effect runs
// twice, and two facades racing two imports of the same specifier leaves
// vitest's mocked-module registry stuck — the surviving facade waits forever.
let ghosttySurfaceModulePromise: Promise<typeof import('../ghostty/surface')> | null = null
function ghosttySurfaceModule(): Promise<typeof import('../ghostty/surface')> {
  ghosttySurfaceModulePromise ??= import('../ghostty/surface')
  return ghosttySurfaceModulePromise
}

const SKELETON_WIDTHS = [58, 34, 71, 45, 62, 28, 50]

const PANE_TOAST_MS = 3000

function resolveCandidates(raw: string, cwd: string, projectDir: string): string[] {
  if (raw.startsWith('/')) return [raw]
  const candidates = [joinPath(cwd, raw)]
  if (projectDir !== cwd) candidates.push(joinPath(projectDir, raw))
  return candidates
}

export interface OutputSink {
  frame: (offset: number, data: Uint8Array) => void
  replay: (data: Uint8Array, bytesSeen: number) => void
  snapshot: (state: Uint8Array, outputOffset: number) => void
  gap: () => void
  resizeExhausted: () => void
  clipboardCopied: () => void
}
export type RegisterOutput = (id: number, sink: OutputSink) => () => void

// Buffered pre-replay frames beyond this flip the pane to raw streaming — an
// attach reply that never arrives must not buffer forever.
const PENDING_CAP_BYTES = 4 * 1024 * 1024

// Commit copy-on-select once the selection has settled, since onSelectionChange
// fires continuously while a drag is in progress.
const SELECTION_COPY_DEBOUNCE_MS = 250
// Let a starting PTY settle before the one bounded reassertion for a size.
const RESIZE_REASSERT_DELAY_MS = 100

export interface TermActions {
  copy: () => void
  paste: () => void
  clear: () => void
  reset: () => void
  hasSelection: () => boolean
  find: () => void
  copyOutput: (lines: number | 'all') => void
  readOutput: (lines: number | 'all') => string
  toast: (title: string, sub?: string, tone?: 'success' | 'danger') => void
}

const HIBERNATE_DEBOUNCE_MS = 200

// A woken pane has nothing dirty to repaint on its own, and WebKitGTK suspends
// requestAnimationFrame for an unfocused window — so a forced render can be
// queued and not serviced. Multiple delayed attempts land wherever that lands.
const WAKE_REPAINT_DELAYS_MS = [120, 400]

// The daemon retains up to 4 MiB; the engine only keeps MAX_SCROLLBACK_ROWS
// (10_000, ~2 MiB of dense agent output), so bytes above that only produce rows
// it immediately evicts. A wrong value shows as shorter scroll-up, never data loss.
const ATTACH_REPLAY_BYTES = 2 * 1024 * 1024

// A restored grid mounts every pane at once; only the focused one asks for the
// full window above, the rest ask for one screenful and grow from live output.
const ATTACH_REPLAY_BYTES_BACKGROUND = 64 * 1024

interface Props {
  client: HoustonClient
  info: SessionInfo
  theme: ThemeName
  active: boolean
  connected: boolean
  fontSize: number
  openLinksInPane?: boolean
  onOpenUrlInPane?: (url: string) => void
  shiftEnterNewline?: boolean
  fontFamily?: string
  copyOnSelect: boolean
  stripBoxGlyphs: boolean
  registerOutput: RegisterOutput
  onActivate: () => void
  onZoom: (dir: 1 | -1 | 0) => void
  onShellZoom: (dir: 1 | -1 | 0) => void
  actions?: React.RefObject<TermActions | null>
  onOpenFile: (path: string, line?: number, col?: number) => void
  onOpenDir: (path: string) => void
}

export function TerminalPane({
  client,
  info,
  theme,
  active,
  connected,
  fontSize,
  fontFamily = TERMINAL_FONT_DEFAULT,
  shiftEnterNewline = true,
  openLinksInPane = false,
  onOpenUrlInPane,
  copyOnSelect,
  stripBoxGlyphs,
  registerOutput,
  onActivate,
  onZoom,
  onShellZoom,
  actions,
  onOpenFile,
  onOpenDir
}: Props): React.JSX.Element {
  const expandedId = useContext(ExpandedContext)
  const gridHidden = useContext(GridHiddenContext)
  const hiddenByExpand = gridHidden || (expandedId != null && expandedId !== info.id)
  const warm = useContext(WarmContext)
  const keymapOverrides = useContext(KeymapOverridesContext)
  const keymapOverridesRef = useRef(keymapOverrides)
  keymapOverridesRef.current = keymapOverrides
  const tuning = useContext(TerminalTuningContext)
  const shiftEnterRef = useRef(shiftEnterNewline)
  shiftEnterRef.current = shiftEnterNewline
  const openLinksInPaneRef = useRef(openLinksInPane)
  openLinksInPaneRef.current = openLinksInPane
  const onOpenUrlInPaneRef = useRef(onOpenUrlInPane)
  onOpenUrlInPaneRef.current = onOpenUrlInPane
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<PaneTerminal | null>(null)
  const writeQueueRef = useRef<PaneWriteQueue | null>(null)
  const searchRef = useRef<PaneFinder | null>(null)
  const ghosttyTermRef = useRef<GhosttyPaneTerminal | null>(null)
  const syncSizeRef = useRef<() => void>(() => {})
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const lastReassertedSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeReassertTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const skipSnapshotOnceRef = useRef(false)
  const [find, setFind] = useState(false)
  const [findTerm, setFindTerm] = useState('')
  const [synced, setSynced] = useState(false)
  const activeAtMountRef = useRef(active)
  const [skeletonGone, setSkeletonGone] = useState(false)
  const [surfaceAttached, setSurfaceAttached] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const [dragFileCount, setDragFileCount] = useState(0)
  const [dragHasImages, setDragHasImages] = useState(false)
  const [dropBusy, setDropBusy] = useState(false)
  const pendingDropsRef = useRef(0)
  const notices = useNotices()
  const toastSeqRef = useRef(0)
  const pushToastRef = useRef<
    (title: string, sub?: string, tone?: 'success' | 'danger', replaceKey?: string) => void
  >(() => {})
  const uploadSeqRef = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const copyOnSelectRef = useRef(copyOnSelect)
  copyOnSelectRef.current = copyOnSelect
  const stripBoxGlyphsRef = useRef(stripBoxGlyphs)
  stripBoxGlyphsRef.current = stripBoxGlyphs
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  const onZoomRef = useRef(onZoom)
  onZoomRef.current = onZoom
  const onShellZoomRef = useRef(onShellZoom)
  onShellZoomRef.current = onShellZoom
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile
  const onOpenDirRef = useRef(onOpenDir)
  onOpenDirRef.current = onOpenDir
  const clientRef = useRef(client)
  clientRef.current = client
  const seqRef = useRef({
    synced: false,
    cursor: 0,
    pending: [] as { offset: number; data: Uint8Array }[],
    pendingBytes: 0,
    catchup: false,
    awaitingSnapshot: false
  })

  useEffect(() => {
    if (!synced) {
      setSkeletonGone(false)
      return
    }
    const t = setTimeout(() => setSkeletonGone(true), 560)
    return () => clearTimeout(t)
  }, [synced])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setSurfaceAttached(false)
    const ghosttyTerm = new GhosttyPaneTerminal({
      host,
      theme: TERMINAL_PALETTES[theme],
      fontFamily,
      fontSize,
      lineHeight: tuning.lineHeight,
      cursorBlink: tuning.cursorBlink,
      maxScrollbackLines: tuning.scrollbackLines,
      disableStdin: !(activeRef.current && connectedRef.current),
      sessionId: info.id,
      load: async (mountEl, options) => {
        const mod = await ghosttySurfaceModule()
        return mod.GhosttyTerminalSurface.create(mountEl, options)
      },
      toGhosttyTheme: ghosttyThemeFromCss,
      onAttached: () => setSurfaceAttached(true),
      onAttachOverflow: (totalDropped) => {
        pushToastRef.current(
          'Output dropped',
          `${totalDropped} bytes total — this pane's engine was still starting`,
          'danger',
          'backpressure'
        )
      }
    })
    const term: PaneTerminal = ghosttyTerm
    termRef.current = term
    ghosttyTermRef.current = ghosttyTerm
    const writeQueue = new PaneWriteQueue({
      write: (payload, callback) => {
        term.write(payload, callback)
      },
      isAltBuffer: () => term.buffer.active.type === 'alternate',
      onLossOutOfBand: (totalDropped) => {
        pushToastRef.current(
          'Output dropped',
          `${totalDropped} bytes total — this pane fell behind`,
          'danger',
          'backpressure'
        )
      }
    })
    writeQueueRef.current = writeQueue
    const ghostty = ghosttyTerm
    const fitTerminal = (): boolean => ghostty.fit()
    searchRef.current = createGhosttyFinder({
      cols: ghostty.cols,
      bufferRowCount: () => ghostty.bufferRowCount(),
      withScreenReader: (read) => ghostty.withScreenReader(read),
      selectScreenRange: (start, end) => ghostty.selectScreenRange(start, end),
      revealScreenRow: (row) => ghostty.revealScreenRow(row),
      clearSelection: () => ghostty.clearSelection()
    })
    ghostty.urlActivate = (url) => {
      const inPane = openLinksInPaneRef.current && onOpenUrlInPaneRef.current !== undefined
      if (inPane) {
        onOpenUrlInPaneRef.current?.(url)
        return
      }
      void openExternal(url).catch((err: unknown) => {
        console.warn('houston: openExternal failed', err)
      })
    }
    const webLinkProvider: PaneLinkProvider = {
      provideLinks(bufferLineNumber: number, callback) {
        const buffer = term.buffer.active
        const queriedRow = bufferLineNumber - 1
        const line = buffer.getLine(queriedRow)
        if (!line) {
          callback(undefined)
          return
        }
        const joined = joinWrappedLine(buffer, queriedRow)
        const matches = findUrls(joined.text)
        const links: PaneLink[] = []
        for (const m of matches) {
          const startPos = mapJoinedOffset(joined, m.start)
          const endPos = mapJoinedOffset(joined, m.end - 1)
          if (queriedRow < startPos.row || queriedRow > endPos.row) continue
          links.push({
            text: m.url,
            range: {
              start: { x: startPos.col + 1, y: startPos.row + 1 },
              end: { x: endPos.col + 1, y: endPos.row + 1 }
            },
            activate: () => {
              const inPane = openLinksInPaneRef.current && onOpenUrlInPaneRef.current !== undefined
              if (inPane) {
                onOpenUrlInPaneRef.current?.(m.url)
                return
              }
              void openExternal(m.url).catch((err: unknown) => {
                console.warn('houston: openExternal failed', err)
              })
            }
          })
        }
        callback(links.length > 0 ? links : undefined)
      }
    }
    const webLinkProviderDisposable = term.registerLinkProvider(webLinkProvider)

    const linkProvider: PaneLinkProvider = {
      provideLinks(bufferLineNumber: number, callback) {
        const buffer = term.buffer.active
        const queriedRow = bufferLineNumber - 1
        const line = buffer.getLine(queriedRow)
        if (!line) {
          callback(undefined)
          return
        }
        const text = line.translateToString(true)
        const joined = joinWrappedLine(buffer, queriedRow)
        const rowIndex = joined.rows.indexOf(queriedRow)
        const rowStart = rowIndex === -1 ? 0 : joined.rowStarts[rowIndex]
        const urlMatches = findUrls(joined.text)
        const matches = [...text.matchAll(FILE_TOKEN_RE)].filter((m) => {
          if (m.index === undefined) return true
          const start = rowStart + m.index
          const end = start + m[0].length
          return !urlMatches.some((u) => rangesOverlap(start, end, u.start, u.end))
        })
        if (matches.length === 0) {
          callback(undefined)
          return
        }
        void Promise.all(
          matches.map(async (m): Promise<PaneLink | null> => {
            const raw = m.groups?.path
            if (!raw || m.index === undefined) return null
            const lineNo = m.groups?.line ? Number(m.groups.line) : undefined
            const colNo = m.groups?.col ? Number(m.groups.col) : undefined
            for (const candidate of resolveCandidates(raw, info.cwd, info.project_dir)) {
              const kind = await checkPathKind(candidate)
              if (kind) {
                return {
                  text: m[0],
                  range: {
                    start: { x: m.index + 1, y: bufferLineNumber },
                    end: { x: m.index + m[0].length, y: bufferLineNumber }
                  },
                  activate: () =>
                    kind === 'dir'
                      ? onOpenDirRef.current(candidate)
                      : onOpenFileRef.current(candidate, lineNo, colNo)
                }
              }
            }
            return null
          })
        ).then(
          (links) => {
            const valid = links.filter((l): l is PaneLink => l !== null)
            callback(valid.length > 0 ? valid : undefined)
          },
          () => callback(undefined)
        )
      }
    }
    const linkProviderDisposable = term.registerLinkProvider(linkProvider)

    const sendSize = (cols: number, rows: number): void => {
      const reasserted = lastReassertedSizeRef.current
      if (reasserted && (reasserted.cols !== cols || reasserted.rows !== rows)) {
        lastReassertedSizeRef.current = null
      }
      const last = lastSentSizeRef.current
      if (last && last.cols === cols && last.rows === rows) return
      lastSentSizeRef.current = { cols, rows }
      clientRef.current.resizeSession(info.id, cols, rows)
    }
    const syncSize = (): void => {
      if (!host.offsetWidth || !host.offsetHeight) return
      if (!ghostty.attached) return
      // A refused fit leaves `term.cols`/`term.rows` on the last real grid,
      // and reporting that again would be a lie about a box that shrank.
      if (!fitTerminal()) return
      sendSize(term.cols, term.rows)
    }
    syncSizeRef.current = syncSize
    syncSize()
    ghostty.onResize(sendSize)

    const writeClipboardText = (text: string, onSuccess?: () => void): void => {
      void navigator.clipboard.writeText(text).then(onSuccess, (err: unknown) => {
        pushToast('Copy failed', err instanceof Error ? err.message : String(err), 'danger')
      })
    }
    const copySelection = (): void => {
      const sel = term.getSelection()
      if (!sel) return
      writeClipboardText(stripBoxGlyphsRef.current ? stripBox(sel) : sel)
    }
    let selectionCopyTimer: ReturnType<typeof setTimeout> | undefined
    const onTermSelectionChange = (): void => {
      if (selectionCopyTimer !== undefined) clearTimeout(selectionCopyTimer)
      selectionCopyTimer = setTimeout(() => {
        selectionCopyTimer = undefined
        if (!copyOnSelectRef.current) return
        const sel = term.getSelection()
        if (!sel) return
        const text = stripBoxGlyphsRef.current ? stripBox(sel) : sel
        writeClipboardText(text, () => pushToast('Copied', undefined, 'success', 'auto-copy'))
      }, SELECTION_COPY_DEBOUNCE_MS)
    }
    const selectionChangeDisposable = term.onSelectionChange(onTermSelectionChange)
    const pastePath = (path: string): boolean => {
      onActivateRef.current()
      if (!connectedRef.current) {
        pushToast('Paste failed', 'daemon connection lost', 'danger')
        return false
      }
      term.options.disableStdin = false
      term.paste(shellQuote(path) + ' ')
      return true
    }
    const saveAndPasteImage = async (blob: Blob, mime: string): Promise<void> => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const sizeError = checkImageSizeCap(bytes.length)
      if (sizeError) throw new Error(sizeError)
      const ext = mime.split('/')[1] || 'png'
      pastePath(await saveImage(bytes, ext))
    }
    const pasteFromClipboard = async (): Promise<void> => {
      let imagePath: string | null = null
      try {
        imagePath = await readClipboardImagePath()
      } catch (err: unknown) {
        pushToast(
          'Paste failed',
          `cannot read clipboard image: ${err instanceof Error ? err.message : String(err)}`,
          'danger'
        )
      }
      if (imagePath) {
        pastePath(imagePath)
        return
      }
      const text = await readClipboardText()
      if (!text) return
      if (!connectedRef.current) {
        pushToast('Paste failed', 'daemon connection lost', 'danger')
        return
      }
      term.paste(text)
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keyup') {
        if (endsDictationHold(e, keymapOverridesRef.current)) voiceChordUp(info.id)
        return true
      }
      if (e.type !== 'keydown') return true
      if (isDictationChord(e, keymapOverridesRef.current) && voiceChordDown(info.id)) {
        e.preventDefault()
        return false
      }
      if (!passKeysToTerminal()) {
        const kc = keymapOverridesRef.current
        const isZoomIn = resolveGlobalMatch(zoomIn, kc)(e)
        const isZoomOut = resolveGlobalMatch(zoomOut, kc)(e)
        const isZoomReset = resolveGlobalMatch(zoomReset, kc)(e)
        if (isZoomIn || isZoomOut || isZoomReset) {
          e.preventDefault()
          onShellZoomRef.current(isZoomReset ? 0 : isZoomIn ? 1 : -1)
          return false
        }
        const isFontIn = resolveGlobalMatch(fontZoomIn, kc)(e)
        const isFontOut = resolveGlobalMatch(fontZoomOut, kc)(e)
        const isFontReset = resolveGlobalMatch(fontZoomReset, kc)(e)
        if (isFontIn || isFontOut || isFontReset) {
          e.preventDefault()
          onZoomRef.current(isFontReset ? 0 : isFontIn ? 1 : -1)
          return false
        }
      }
      const shiftEnter = shiftEnterSequence(e, shiftEnterRef.current)
      if (shiftEnter !== null) {
        e.preventDefault()
        clientRef.current.sendStdin(info.id, shiftEnter)
        return false
      }
      if (isPasteChord(e)) {
        e.preventDefault()
        void pasteFromClipboard()
        return false
      }
      const ctrl = e.ctrlKey && !e.altKey && !e.metaKey
      if (!ctrl) return true
      if (!e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setFind(true)
        return false
      }
      if (e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault()
        copySelection()
        return false
      }
      return true
    })

    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          e.preventDefault()
          e.stopPropagation()
          const file = it.getAsFile()
          if (file) {
            void saveAndPasteImage(file, it.type).catch((err: unknown) => {
              pushToast(
                'Paste failed',
                `cannot save pasted image: ${err instanceof Error ? err.message : String(err)}`,
                'danger'
              )
            })
          }
          return
        }
      }
    }
    const readDragItems = (dt: DataTransfer | null): { count: number; hasImages: boolean } => {
      if (!dt) return { count: 0, hasImages: false }
      let count = 0
      let hasImages = false
      for (const item of dt.items) {
        if (item.kind !== 'file') continue
        count++
        if (item.type.startsWith('image/')) hasImages = true
      }
      return { count: count || 1, hasImages }
    }
    const onDragOver = (e: DragEvent): void => {
      if (!dragCarriesFiles(e.dataTransfer)) return
      e.preventDefault()
      const { count, hasImages } = readDragItems(e.dataTransfer)
      setDragFileCount(count)
      setDragHasImages(hasImages)
    }
    const onDragEnter = (e: DragEvent): void => {
      if (!dragCarriesFiles(e.dataTransfer)) return
      dragCounterRef.current++
      setDragOver(true)
      const { count, hasImages } = readDragItems(e.dataTransfer)
      setDragFileCount(count)
      setDragHasImages(hasImages)
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!dragCarriesFiles(e.dataTransfer)) return
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
      if (dragCounterRef.current === 0) setDragOver(false)
    }
    const pushToast = (
      title: string,
      sub?: string,
      tone?: 'success' | 'danger',
      replaceKey?: string
    ): void => {
      notices.push({
        code: replaceKey ?? `toast-${++toastSeqRef.current}`,
        kind: tone === 'success' ? 'success' : tone === 'danger' ? 'error' : 'info',
        title,
        body: sub,
        durationMs: PANE_TOAST_MS
      })
    }
    pushToastRef.current = pushToast
    const pushPathToast = (path: string): void =>
      pushToast('Path pasted', collapseHome(path), 'success')

    let tuiDragStart: CellPos | null = null
    const isTuiDragGate = (e: MouseEvent): boolean =>
      e.ctrlKey &&
      e.shiftKey &&
      term.buffer.active.type === 'alternate' &&
      term.modes.mouseTrackingMode !== 'none'
    const tuiDragScreenRect = (): CellRect => {
      const screenEl = host.querySelector<HTMLElement>('[data-testid="ghostty-canvas"]')
      if (screenEl) return screenEl.getBoundingClientRect()
      const hostRect = host.getBoundingClientRect()
      const style = window.getComputedStyle(host)
      const padLeft = parseFloat(style.paddingLeft) || 0
      const padTop = parseFloat(style.paddingTop) || 0
      const padRight = parseFloat(style.paddingRight) || 0
      const padBottom = parseFloat(style.paddingBottom) || 0
      return {
        left: hostRect.left + padLeft,
        top: hostRect.top + padTop,
        width: hostRect.width - padLeft - padRight,
        height: hostRect.height - padTop - padBottom
      }
    }
    const cellFromEvent = (e: MouseEvent): CellPos => {
      const rect = tuiDragScreenRect()
      const screen = pixelToCell(term.cols, term.rows, rect, e.clientX, e.clientY)
      return { col: screen.col, row: term.buffer.active.viewportY + screen.row }
    }
    const onTuiDragMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0 || !isTuiDragGate(e)) return
      onActivateRef.current()
      tuiDragStart = cellFromEvent(e)
      e.preventDefault()
      e.stopImmediatePropagation()
      window.addEventListener('mousemove', onTuiDragMouseMove, true)
      window.addEventListener('mouseup', onTuiDragMouseUp, true)
    }
    const onTuiDragMouseMove = (e: MouseEvent): void => {
      if (!tuiDragStart) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const onTuiDragMouseUp = (e: MouseEvent): void => {
      if (!tuiDragStart) return
      const start = tuiDragStart
      tuiDragStart = null
      window.removeEventListener('mousemove', onTuiDragMouseMove, true)
      window.removeEventListener('mouseup', onTuiDragMouseUp, true)
      e.preventDefault()
      e.stopImmediatePropagation()
      const end = cellFromEvent(e)
      const text = extractDragRangeText(term.buffer.active, start, end, stripBoxGlyphsRef.current)
      if (text.trim() === '') {
        pushToast(TUI_DRAG_EMPTY_HINT)
        return
      }
      void navigator.clipboard.writeText(text).then(
        () => pushToast('Copied selection', undefined, 'success'),
        (err: unknown) => pushToast('Copy failed', err instanceof Error ? err.message : String(err), 'danger')
      )
    }

    const onDrop = (e: DragEvent): void => {
      dragCounterRef.current = 0
      const entries = readDropEntries(e.dataTransfer)
      if (entries.length === 0) {
        setDragOver(false)
        return
      }
      e.preventDefault()

      pendingDropsRef.current++
      setDropBusy(true)
      const settleDrop = (): void => {
        pendingDropsRef.current--
        if (pendingDropsRef.current === 0) {
          setDropBusy(false)
          setDragOver(false)
        }
      }

      void (async () => {
        try {
          if (info.ssh_host != null) await uploadDroppedEntries(entries)
          else await pasteDroppedEntries(entries)
        } finally {
          settleDrop()
        }
      })()
    }

    const pasteDroppedEntries = async (entries: DropEntry[]): Promise<void> => {
      const resolutions = await Promise.allSettled(
        entries.map((entry) => (entry.path ? entry.path : resolveDroppedFile(entry.file!)))
      )
      for (let i = 0; i < entries.length; i++) {
        const f = entries[i].file
        const resolution = resolutions[i]
        if (resolution.status === 'rejected') {
          const reason = resolution.reason
          pushToast(
            'Paste failed',
            reason instanceof Error ? reason.message : String(reason),
            'danger'
          )
          continue
        }
        const path = resolution.value
        if (path) {
          if (pastePath(path)) pushPathToast(path)
        } else if (f && f.type.startsWith('image/')) {
          try {
            await saveAndPasteImage(f, f.type)
          } catch (err: unknown) {
            pushToast(
              'Paste failed',
              `cannot save dropped image ${f.name}: ${err instanceof Error ? err.message : String(err)}`,
              'danger'
            )
          }
        }
      }
    }

    const uploadDroppedEntries = async (entries: DropEntry[]): Promise<void> => {
      const resolutions = await Promise.allSettled(
        entries.map((entry) => (entry.path ? entry.path : resolveDroppedFile(entry.file!)))
      )
      for (let i = 0; i < entries.length; i++) {
        const f = entries[i].file
        const resolution = resolutions[i]
        if (resolution.status === 'rejected') {
          const reason = resolution.reason
          pushToast(
            'Upload failed',
            reason instanceof Error ? reason.message : String(reason),
            'danger'
          )
          continue
        }
        const path = resolution.value
        if (!path) {
          pushToast('Upload failed', `${f?.name ?? 'the dropped item'} has no file to send`, 'danger')
          continue
        }
        const request = ++uploadSeqRef.current
        clientRef.current.sshUploadTerminalFile(request, info.id, path, f?.name)
        pushToast('Uploading…', f?.name ?? collapseHome(path), undefined, `ssh-upload-${path}`)
      }
    }

    host.addEventListener('paste', onPaste, true)
    host.addEventListener('mousedown', onTuiDragMouseDown, true)
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('dragenter', onDragEnter)
    host.addEventListener('dragleave', onDragLeave)
    host.addEventListener('drop', onDrop)

    const onWindowBlur = (): void => abandonDictation(info.id)
    window.addEventListener('blur', onWindowBlur)

    const unregisterVoice = registerVoiceInsert(info.id, (text) => {
      onActivateRef.current()
      if (!connectedRef.current) return false
      term.options.disableStdin = false
      term.paste(text)
      return true
    })

    const unregisterVoiceNotice = registerVoiceNotice(info.id, (message) =>
      pushToast(message, undefined, 'danger', 'voice-failure')
    )

    const readOutput = (lines: number | 'all'): string =>
      outputText(
        ghosttyTermRef.current?.getFullText(),
        term.buffer.active,
        lines,
        stripBoxGlyphsRef.current
      )

    if (actions) {
      actions.current = {
        copy: copySelection,
        paste: () => {
          onActivateRef.current()
          term.options.disableStdin = false
          void pasteFromClipboard()
        },
        clear: () => term.clear(),
        reset: () => term.reset(),
        hasSelection: () => term.hasSelection(),
        find: () => setFind(true),
        readOutput: readOutput,
        copyOutput: (lines) => {
          const text = readOutput(lines)
          writeClipboardText(text)
          pushToast(
            lines === 'all' ? 'Copied all output' : `Copied last ${lines} lines`,
            undefined,
            'success'
          )
        },
        toast: pushToast
      }
    }

    const imeState = { current: emptyImeDedupState() }
    const tracing = inputTraceEnabled()
    const textareaLen = (): number => term.textarea?.value.length ?? -1
    const onCompositionStart = (e: Event): void => {
      if (tracing) {
        traceInputEvent(info.id, 'compositionstart', (e as CompositionEvent).data ?? '', {
          taLen: textareaLen()
        })
      }
    }
    const onCompositionUpdate = (e: Event): void => {
      traceInputEvent(info.id, 'compositionupdate', (e as CompositionEvent).data ?? '', {
        taLen: textareaLen()
      })
    }
    const onKeyDownTrace = (e: Event): void => {
      const ke = e as KeyboardEvent
      logTerminalTransport({
        source: 'input-trace',
        message: 'keydown',
        payload: {
          session: info.id,
          at: Math.round(performance.now()),
          key: ke.key,
          code: ke.code,
          isComposing: ke.isComposing,
          keyCode: ke.keyCode,
          taLen: textareaLen()
        }
      })
    }
    const onCompositionEnd = (e: Event): void => {
      const data = (e as CompositionEvent).data ?? ''
      if (tracing) traceInputEvent(info.id, 'compositionend', data, { taLen: textareaLen() })
      imeState.current = noteCompositionEnd(data, performance.now())
    }
    term.textarea?.addEventListener('compositionend', onCompositionEnd)
    if (tracing) {
      term.textarea?.addEventListener('compositionstart', onCompositionStart)
      term.textarea?.addEventListener('compositionupdate', onCompositionUpdate)
      term.textarea?.addEventListener('keydown', onKeyDownTrace)
    }

    const disposeData = term.onData((d) => {
      const { deliver, state } = decideImeDelivery(imeState.current, d, performance.now())
      imeState.current = state
      if (tracing) {
        traceInputEvent(info.id, deliver ? 'onData:deliver' : 'onData:drop', d, {
          taLen: textareaLen()
        })
      }
      if (deliver && !seqRef.current.awaitingSnapshot) {
        clientRef.current.sendStdin(info.id, d)
      }
    })

    seqRef.current = {
      synced: false,
      cursor: 0,
      pending: [],
      pendingBytes: 0,
      catchup: false,
      awaitingSnapshot: false
    }
    const writeFrom = (offset: number, data: Uint8Array, exempt = false): boolean => {
      const s = seqRef.current
      if (offset + data.length <= s.cursor) return true
      if (!exempt && offset > s.cursor) {
        resetAndReattach()
        return false
      }
      writeQueue.enqueue(offset < s.cursor ? data.subarray(s.cursor - offset) : data, exempt)
      s.cursor = offset + data.length
      return true
    }
    const unregister = registerOutput(info.id, {
      frame: (offset, data) => {
        const s = seqRef.current
        if (s.synced && !s.catchup) {
          writeFrom(offset, data)
          return
        }
        s.pending.push({ offset, data })
        s.pendingBytes += data.length
        if (s.pendingBytes > PENDING_CAP_BYTES) {
          if (s.catchup || s.awaitingSnapshot) {
            resetAndReattach()
            return
          }
          s.synced = true
          setSynced(true)
          const pending = s.pending
          s.pending = []
          s.pendingBytes = 0
          for (const p of pending) if (!writeFrom(p.offset, p.data, true)) break
        }
      },
      replay: (data, bytesSeen) => {
        const s = seqRef.current
        if (s.synced) {
          if (!s.catchup) return
          s.catchup = false
          const flushCatchup = (): void => {
            const held = s.pending
            s.pending = []
            s.pendingBytes = 0
            for (const p of held) if (!writeFrom(p.offset, p.data, true)) break
          }
          if (bytesSeen <= s.cursor) {
            flushCatchup()
            return
          }
          const replayStart = bytesSeen - data.length
          if (s.cursor >= replayStart) {
            writeQueue.enqueue(data.subarray(s.cursor - replayStart), true)
            s.cursor = bytesSeen
            flushCatchup()
          } else {
            resetAndReattach()
          }
          return
        }
        if (data.length > 0) writeQueue.enqueue(data, true)
        s.cursor = bytesSeen
        s.synced = true
        setSynced(true)
        const pending = s.pending
        s.pending = []
        s.pendingBytes = 0
        for (const p of pending) writeFrom(p.offset, p.data, true)
      },
      snapshot: (state, outputOffset) => {
        const s = seqRef.current
        s.awaitingSnapshot = false
        const term = termRef.current
        if (!term || !term.importSnapshot(state)) {
          console.warn(
            `houston: session ${info.id} refused a ${state.length}-byte attach snapshot; falling back to a byte replay`
          )
          skipSnapshotOnceRef.current = true
          resetAndReattach()
          return
        }
        s.cursor = outputOffset
        s.catchup = false
        s.synced = true
        setSynced(true)
        const pending = s.pending
        s.pending = []
        s.pendingBytes = 0
        for (const p of pending) if (!writeFrom(p.offset, p.data, true)) break
      },
      gap: () => {
        if (!seqRef.current.synced) return
        resetAndReattach()
      },
      resizeExhausted: () => {
        lastSentSizeRef.current = null
        const term = termRef.current
        const measured = term ? { cols: term.cols, rows: term.rows } : null
        const reasserted = lastReassertedSizeRef.current
        if (
          measured === null ||
          (reasserted && reasserted.cols === measured.cols && reasserted.rows === measured.rows)
        ) {
          return
        }
        if (resizeReassertTimerRef.current !== undefined) {
          clearTimeout(resizeReassertTimerRef.current)
        }
        lastReassertedSizeRef.current = measured
        resizeReassertTimerRef.current = setTimeout(() => {
          resizeReassertTimerRef.current = undefined
          syncSizeRef.current()
        }, RESIZE_REASSERT_DELAY_MS)
      },
      clipboardCopied: () => pushToast('Copied', undefined, 'success', 'auto-copy')
    })
    if (!warmRef.current) {
      clientRef.current.sessionVisibility(info.id, true)
      sendAttach(activeAtMountRef.current ? ATTACH_REPLAY_BYTES : ATTACH_REPLAY_BYTES_BACKGROUND)
      attachedRef.current = true
    }

    let resizeFrame: number | undefined
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        syncSize()
      })
    })
    observer.observe(host)

    return () => {
      if (attachedRef.current) clientRef.current.sessionVisibility(info.id, false)
      observer.disconnect()
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      if (resizeReassertTimerRef.current !== undefined) {
        clearTimeout(resizeReassertTimerRef.current)
        resizeReassertTimerRef.current = undefined
      }
      host.removeEventListener('paste', onPaste, true)
      host.removeEventListener('mousedown', onTuiDragMouseDown, true)
      window.removeEventListener('mousemove', onTuiDragMouseMove, true)
      window.removeEventListener('mouseup', onTuiDragMouseUp, true)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('dragenter', onDragEnter)
      host.removeEventListener('dragleave', onDragLeave)
      host.removeEventListener('drop', onDrop)
      window.removeEventListener('blur', onWindowBlur)
      if (selectionCopyTimer !== undefined) clearTimeout(selectionCopyTimer)
      selectionChangeDisposable.dispose()
      unregister()
      unregisterVoice()
      unregisterVoiceNotice()
      abandonDictation(info.id)
      term.textarea?.removeEventListener('compositionend', onCompositionEnd)
      if (tracing) {
        term.textarea?.removeEventListener('compositionstart', onCompositionStart)
        term.textarea?.removeEventListener('compositionupdate', onCompositionUpdate)
        term.textarea?.removeEventListener('keydown', onKeyDownTrace)
      }
      disposeData.dispose()
      linkProviderDisposable.dispose()
      webLinkProviderDisposable.dispose()
      writeQueue.dispose()
      term.dispose()
      termRef.current = null
      ghosttyTermRef.current = null
      writeQueueRef.current = null
      searchRef.current = null
      if (actions) actions.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.id])

  useEffect(() => {
    if (info.ssh_host == null) return
    return client.subscribe('ssh_upload_done', (msg) => {
      if (msg.session !== info.id) return
      pushToastRef.current('Uploaded', msg.remote_path, 'success')
    })
  }, [client, info.id, info.ssh_host])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (active && surfaceAttached) {
      term.focus()
    } else if (!active) {
      term.blur()
    }
  }, [active, surfaceAttached])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.disableStdin = !(active && connected)
  }, [active, connected])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = TERMINAL_PALETTES[theme]
  }, [theme])

  const warmRef = useRef(warm)
  warmRef.current = warm
  const attachedRef = useRef(false)
  const hibernateTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hibernatedRef = useRef(false)
  const wakeRepaintRef = useRef<{
    raf: number | null
    timers: ReturnType<typeof setTimeout>[]
  }>({ raf: null, timers: [] })

  const cancelWakeRepaint = (): void => {
    const state = wakeRepaintRef.current
    if (state.raf !== null) cancelAnimationFrame(state.raf)
    state.raf = null
    state.timers.forEach(clearTimeout)
    state.timers = []
  }

  const runWakeRepaint = (): void => {
    cancelWakeRepaint()
    const paint = (): void => {
      const term = termRef.current
      const host = hostRef.current
      if (!term || !host) return
      if (!host.offsetWidth || !host.offsetHeight) return
      try {
        term.refresh(0, Math.max(0, term.rows - 1))
      } catch {
      }
    }
    paint()
    wakeRepaintRef.current.raf = requestAnimationFrame(() => {
      wakeRepaintRef.current.raf = null
      paint()
    })
    wakeRepaintRef.current.timers = WAKE_REPAINT_DELAYS_MS.map((ms) => setTimeout(paint, ms))
  }

  useEffect(() => {
    return () => cancelWakeRepaint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** A browser may drop an occluded canvas's backing store, and an idle CLI
   * has nothing dirty to repaint it. `focus` carries alt-tab-back, where the
   * page may never be reported hidden; `visibilitychange` carries minimize. */
  useEffect(() => {
    const wake = (): void => {
      syncSizeRef.current()
      runWakeRepaint()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') wake()
    }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!warm) {
      if (hibernateTimerRef.current !== undefined) {
        clearTimeout(hibernateTimerRef.current)
        hibernateTimerRef.current = undefined
      }
      if (!attachedRef.current) {
        syncSizeRef.current()
        seqRef.current.catchup = true
        if (seqRef.current.synced) skipSnapshotOnceRef.current = true
        clientRef.current.sessionVisibility(info.id, true)
        sendAttach(ATTACH_REPLAY_BYTES)
        attachedRef.current = true
      }
      if (hibernatedRef.current) {
        hibernatedRef.current = false
        runWakeRepaint()
      }
      return
    }
    hibernatedRef.current = true
    cancelWakeRepaint()
    if (hibernateTimerRef.current !== undefined) return
    hibernateTimerRef.current = setTimeout(() => {
      hibernateTimerRef.current = undefined
      if (!warmRef.current || !attachedRef.current) return
      clientRef.current.sessionVisibility(info.id, false)
      attachedRef.current = false
    }, HIBERNATE_DEBOUNCE_MS)
    return () => {
      if (hibernateTimerRef.current !== undefined) {
        clearTimeout(hibernateTimerRef.current)
        hibernateTimerRef.current = undefined
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warm])

  const prevHiddenRef = useRef(hiddenByExpand)
  useEffect(() => {
    const wasHidden = prevHiddenRef.current
    prevHiddenRef.current = hiddenByExpand
    termRef.current?.setPaused(hiddenByExpand)
    if (wasHidden && !hiddenByExpand) {
      syncSizeRef.current()
      runWakeRepaint()
    }
  }, [hiddenByExpand])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.fontFamily = fontFamily
    syncSizeRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize, fontFamily])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.lineHeight = tuning.lineHeight
    syncSizeRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tuning.lineHeight])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorBlink = tuning.cursorBlink
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tuning.cursorBlink])

  const wantsSnapshot = (): boolean => {
    const c = clientRef.current
    if (!c.snapshotAttach) return false
    if (skipSnapshotOnceRef.current) return false
    const ours = termRef.current?.snapshotFormatVersion() ?? null
    return ours === null || ours === c.snapshotFormatVersion
  }

  const sendAttach = (replayBytes: number): void => {
    clientRef.current.abandonAttach?.(info.id)
    const snapshot = wantsSnapshot()
    skipSnapshotOnceRef.current = false
    seqRef.current.awaitingSnapshot = snapshot
    clientRef.current.attachSession(info.id, replayBytes, snapshot || undefined)
  }

  const resetAndReattach = (): void => {
    writeQueueRef.current?.discardPendingForReset()
    termRef.current?.reset()
    seqRef.current = {
      synced: false,
      cursor: 0,
      pending: [],
      pendingBytes: 0,
      catchup: false,
      awaitingSnapshot: false
    }
    setSynced(false)
    sendAttach(ATTACH_REPLAY_BYTES)
  }

  const prevClientRef = useRef(client)
  useEffect(() => {
    if (prevClientRef.current === client) return
    prevClientRef.current = client
    if (isLive(info.state)) resetAndReattach()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  const closeFind = (): void => {
    setFind(false)
    setFindTerm('')
    searchRef.current?.clearDecorations()
    termRef.current?.clearSelection()
    if (activeRef.current) termRef.current?.focus()
  }

  const typeable = surfaceAttached && active && connected

  return (
    <div
      className="flex-1 min-h-0 relative flex flex-col"
      data-typeable={typeable || undefined}
    >
      {find && (
        <div className="absolute top-1.5 right-2.5 z-[calc(var(--z-pane)+3)] flex items-center gap-0.5 py-[3px] px-1 bg-[var(--card-bg)] border border-border rounded-md shadow-[var(--shadow-md)]">
          <input
            className="find-input w-[150px] bg-[var(--content-bg)] border border-border rounded-md text-text-primary [font-style:inherit] [font-variant:inherit] [font-weight:inherit] [font-stretch:inherit] [line-height:inherit] [font-family:inherit]! text-[length:var(--tr-text-sm)] py-[3px] px-2 focus:outline-none focus:[border-color:var(--accent)] focus-visible:[border-color:var(--accent)]"
            autoFocus
            placeholder="find…"
            value={findTerm}
            onChange={(e) => {
              setFindTerm(e.target.value)
              searchRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && e.shiftKey) searchRef.current?.findPrevious(findTerm)
              else if (e.key === 'Enter') searchRef.current?.findNext(findTerm)
              else if (e.key === 'Escape') closeFind()
            }}
            spellCheck={false}
          />
          <Tooltip label="Previous (Shift+Enter)">
            <button
              className={`btn ${BTN_ICO}`}
              onClick={() => searchRef.current?.findPrevious(findTerm)}
            >
              <Icon glyph={IconArrowUp} role="ui" />
            </button>
          </Tooltip>
          <Tooltip label="Next (Enter)">
            <button className={`btn ${BTN_ICO}`} onClick={() => searchRef.current?.findNext(findTerm)}>
              <Icon glyph={IconArrowDown} role="ui" />
            </button>
          </Tooltip>
          <Tooltip label="Close (Esc)">
            <button className={`btn ${BTN_ICO}`} onClick={closeFind}>
              <Icon glyph={IconClose} role="ui" />
            </button>
          </Tooltip>
        </div>
      )}
      <div
        className="term-host flex-1 min-h-0 pt-1.5 pr-1.5 pb-1 pl-2 overscroll-contain [.layout.dragging_&]:pointer-events-none [.layout.resizing_&]:pointer-events-none"
        ref={hostRef}
      />
      {!skeletonGone && (
        <div
          className="absolute inset-0 z-[calc(var(--z-pane)+1)] flex flex-col justify-center gap-[11px] pt-1.5 pr-1.5 pb-1 pl-3 bg-[var(--terminal-skeleton-bg)] pointer-events-none"
          aria-hidden="true"
        >
          <div
            className={`loop-anim w-2 h-4 mb-[3px] bg-[var(--text-primary)] motion-safe:[animation:skeleton-cursor-blink_1s_step-end_infinite] ${
              synced
                ? 'transition-opacity duration-[var(--animate-t-fast)] ease-linear opacity-0'
                : 'motion-reduce:opacity-70'
            }`}
          />
          {SKELETON_WIDTHS.map((w, i) => (
            <div
              key={i}
              className={`loop-anim h-[13px] rounded-[3px] bg-[color-mix(in_srgb,var(--text-faint)_20%,transparent)] transition-opacity duration-[var(--animate-t-fast)] ease-linear motion-safe:[animation:skeleton-shimmer_1.4s_ease-in-out_infinite] ${
                synced ? 'opacity-0' : 'opacity-100 motion-reduce:opacity-70'
              }`}
              style={{ width: `${w}%`, transitionDelay: `${i * 60}ms` }}
            />
          ))}
        </div>
      )}
      {(dragOver || dropBusy) && (
        <div
          className="term-dropzone absolute inset-1.5 z-[calc(var(--z-pane)+2)] flex items-center justify-center gap-2 border-2 border-dashed [border-color:var(--accent)] rounded-[var(--tr-radius-md)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)] text-[length:var(--tr-text-sm)] font-semibold pointer-events-none motion-safe:[animation:term-enter_var(--animate-t-fast)_var(--animate-ease-panel)]"
          aria-hidden="true"
        >
          {dropBusy ? (
            <IconLoaderCircle className={`${ICON_ROLE_CLS.ui} text-primary ${SPIN_CLASS}`}
              aria-hidden
              data-testid="dropzone-icon-busy" />
          ) : dragHasImages ? (
            <IconImage className={`${ICON_ROLE_CLS.ui} text-info`} data-testid="dropzone-icon-image" />
          ) : (
            <DROPZONE_FILE_ICON className={`${ICON_ROLE_CLS.ui} text-primary`} data-testid="dropzone-icon-file" />
          )}
          <span className="tabular-nums">
            {}
            {dropBusy
              ? 'Copying…'
              : info.ssh_host != null
                ? dragFileCount <= 1
                  ? `Drop to upload to ${info.ssh_host}`
                  : `Drop to upload ${dragFileCount} files to ${info.ssh_host}`
                : dragFileCount <= 1
                  ? 'Drop to paste path'
                  : `Drop to paste ${dragFileCount} paths`}
          </span>
        </div>
      )}
      <NoticeStack anchor="pane-corner" label="Pane notices" store={notices} />
    </div>
  )
}
