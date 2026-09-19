import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyChromeTheme,
  applyTheme,
  loadChromeTheme,
  loadTheme,
  resolveTerminalPalette,
  saveTerminalPaletteChoice,
  type ChromeTheme,
  type TerminalPaletteChoice,
  type ThemeName
} from './theme'
import { setZoomFactor } from './houston/bridge'
import { loadNotifyKinds, saveNotifyKinds, type NotifyKinds } from './notifyPrefs'
import { TERMINAL_FONTS, terminalFontStack } from './pane/terminalFonts'
import { SHIFT_ENTER_KEY, shiftEnterEnabled } from './pane/shiftEnter'

export const FONT_KEY = 'tr-font-size'
export const FONT_DEFAULT = 14

export const FONT_MIN = 8
export const FONT_MAX = 24

function loadFontSize(): number {
  const n = Number(localStorage.getItem(FONT_KEY))
  return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEFAULT
}

const FONT_FAMILY_KEY = 'tr-font-family'

const LINKS_IN_PANE_KEY = 'tr-links-in-pane'

export const ZOOM_KEY = 'tr-ui-zoom'
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2

export const ZOOM_STEP = 0.1

function loadUiZoom(): number {
  const n = Number(localStorage.getItem(ZOOM_KEY))
  return Number.isFinite(n) && n >= ZOOM_MIN && n <= ZOOM_MAX ? n : 1
}

export const TERMINAL_LINE_HEIGHT_KEY = 'tr-terminal-line-height'
export const TERMINAL_LINE_HEIGHT_DEFAULT = 1.35
export const TERMINAL_LINE_HEIGHT_MIN = 1
export const TERMINAL_LINE_HEIGHT_MAX = 2
function loadTerminalLineHeight(): number {
  const n = Number(localStorage.getItem(TERMINAL_LINE_HEIGHT_KEY))
  return Number.isFinite(n) && n >= TERMINAL_LINE_HEIGHT_MIN && n <= TERMINAL_LINE_HEIGHT_MAX
    ? n
    : TERMINAL_LINE_HEIGHT_DEFAULT
}

export const TERMINAL_CURSOR_BLINK_KEY = 'tr-terminal-cursor-blink'

export const TERMINAL_SCROLLBACK_KEY = 'tr-terminal-scrollback-lines'
export const TERMINAL_SCROLLBACK_DEFAULT = 10_000
export const TERMINAL_SCROLLBACK_MIN = 1_000
export const TERMINAL_SCROLLBACK_MAX = 30_000
function loadTerminalScrollbackLines(): number {
  const n = Number(localStorage.getItem(TERMINAL_SCROLLBACK_KEY))
  return Number.isFinite(n) && n >= TERMINAL_SCROLLBACK_MIN && n <= TERMINAL_SCROLLBACK_MAX
    ? Math.trunc(n)
    : TERMINAL_SCROLLBACK_DEFAULT
}

const WS_COLORS_KEY = 'tr-ws-colors'
const WS_ORDER_KEY = 'tr-ws-order'

const WS_PINNED_KEY = 'tr-ws-pinned'

const SHELLINT_KEY = 'tr-shell-integration'

const OSC52_KEY = 'tr-osc52'

const COPY_ON_SELECT_KEY = 'tr-copy-on-select'

const STRIP_BOX_GLYPHS_KEY = 'tr-strip-box-glyphs'

const NOTIFY_KEY = 'tr-notify-desktop'

const NOTIFY_SOUND_KEY = 'tr-notify-sound'

function loadStringMap(key: string): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}
const loadWsColors = (): Record<string, string> => loadStringMap(WS_COLORS_KEY)

function loadWsOrder(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WS_ORDER_KEY) ?? '[]')
    return Array.isArray(raw) && raw.every((p) => typeof p === 'string') ? raw : []
  } catch {
    return []
  }
}

function loadWsPinned(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WS_PINNED_KEY) ?? '[]')
    return Array.isArray(raw) && raw.every((p) => typeof p === 'string') ? raw : []
  } catch {
    return []
  }
}

export function usePreferences(): {
  theme: ThemeName
  themeChoice: TerminalPaletteChoice
  setTheme: (t: TerminalPaletteChoice) => void
  chromeTheme: ChromeTheme
  setChromeTheme: (t: ChromeTheme) => void
  chromeMigrationNotice: ThemeName | null
  chromeMigrationNoticeDismissed: boolean
  setChromeMigrationNoticeDismissed: (v: boolean) => void
  fontSize: number
  setFontSize: React.Dispatch<React.SetStateAction<number>>
  terminalLineHeight: number
  setTerminalLineHeight: React.Dispatch<React.SetStateAction<number>>
  terminalCursorBlink: boolean
  setTerminalCursorBlink: React.Dispatch<React.SetStateAction<boolean>>
  terminalScrollbackLines: number
  setTerminalScrollbackLines: React.Dispatch<React.SetStateAction<number>>
  uiZoom: number
  setUiZoom: React.Dispatch<React.SetStateAction<number>>
  shiftEnterNewline: boolean
  setShiftEnterNewline: (v: boolean) => void
  openLinksInPane: boolean
  setOpenLinksInPane: React.Dispatch<React.SetStateAction<boolean>>
  fontFamilyId: string
  setFontFamilyId: React.Dispatch<React.SetStateAction<string>>
  fontFamily: string
  wsColors: Record<string, string>
  setWsColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
  wsOrder: string[]
  setWsOrder: React.Dispatch<React.SetStateAction<string[]>>
  wsPinned: string[]
  setWsPinned: React.Dispatch<React.SetStateAction<string[]>>
  shellIntegration: boolean
  setShellIntegration: React.Dispatch<React.SetStateAction<boolean>>
  osc52: boolean
  setOsc52: React.Dispatch<React.SetStateAction<boolean>>
  osc52Ref: React.MutableRefObject<boolean>
  copyOnSelect: boolean
  setCopyOnSelect: React.Dispatch<React.SetStateAction<boolean>>
  stripBoxGlyphs: boolean
  setStripBoxGlyphs: React.Dispatch<React.SetStateAction<boolean>>
  notifyEnabled: boolean
  setNotifyEnabled: React.Dispatch<React.SetStateAction<boolean>>
  notifyEnabledRef: React.MutableRefObject<boolean>
  notifyKinds: NotifyKinds
  setNotifyKinds: React.Dispatch<React.SetStateAction<NotifyKinds>>
  notifyKindsRef: React.MutableRefObject<NotifyKinds>
  notifySound: boolean
  setNotifySound: React.Dispatch<React.SetStateAction<boolean>>
  notifySoundRef: React.MutableRefObject<boolean>
  changeFont: (dir: 1 | -1 | 0) => void
  changeZoom: (dir: 1 | -1 | 0) => void
} {
  const [themeChoice, setTheme] = useState<TerminalPaletteChoice>(loadTheme)
  const [chromeTheme, setChromeTheme] = useState<ChromeTheme>(() => loadChromeTheme().theme)
  const theme = resolveTerminalPalette(themeChoice, chromeTheme)
  const [chromeMigrationNotice] = useState<ThemeName | null>(() => loadChromeTheme().migratedFrom)
  const [chromeMigrationNoticeDismissed, setChromeMigrationNoticeDismissed] = useState(false)
  const [fontSize, setFontSize] = useState(loadFontSize)
  const [uiZoom, setUiZoom] = useState(loadUiZoom)
  const [terminalLineHeight, setTerminalLineHeight] = useState(loadTerminalLineHeight)
  const [terminalCursorBlink, setTerminalCursorBlink] = useState(
    () => localStorage.getItem(TERMINAL_CURSOR_BLINK_KEY) !== '0'
  )
  const [terminalScrollbackLines, setTerminalScrollbackLines] = useState(
    loadTerminalScrollbackLines
  )
  const [shiftEnterNewline, setShiftEnterNewline] = useState(shiftEnterEnabled)
  const [openLinksInPane, setOpenLinksInPane] = useState(
    () => localStorage.getItem(LINKS_IN_PANE_KEY) !== '0'
  )
  const [fontFamilyId, setFontFamilyId] = useState<string>(
    () => localStorage.getItem(FONT_FAMILY_KEY) ?? TERMINAL_FONTS[0].id
  )
  const fontFamily = terminalFontStack(fontFamilyId)
  const [wsColors, setWsColors] = useState<Record<string, string>>(loadWsColors)
  const [wsOrder, setWsOrder] = useState<string[]>(loadWsOrder)
  const [wsPinned, setWsPinned] = useState<string[]>(loadWsPinned)
  const [shellIntegration, setShellIntegration] = useState(
    () => localStorage.getItem(SHELLINT_KEY) !== '0'
  )
  const [osc52, setOsc52] = useState(() => localStorage.getItem(OSC52_KEY) !== '0')
  const osc52Ref = useRef(osc52)
  osc52Ref.current = osc52
  const [copyOnSelect, setCopyOnSelect] = useState(
    () => localStorage.getItem(COPY_ON_SELECT_KEY) === '1'
  )
  const [stripBoxGlyphs, setStripBoxGlyphs] = useState(
    () => localStorage.getItem(STRIP_BOX_GLYPHS_KEY) !== '0'
  )
  const [notifyEnabled, setNotifyEnabled] = useState(
    () => localStorage.getItem(NOTIFY_KEY) === '1'
  )
  const notifyEnabledRef = useRef(notifyEnabled)
  notifyEnabledRef.current = notifyEnabled
  const [notifyKinds, setNotifyKinds] = useState<NotifyKinds>(loadNotifyKinds)
  const notifyKindsRef = useRef(notifyKinds)
  notifyKindsRef.current = notifyKinds
  const [notifySound, setNotifySound] = useState(
    () => localStorage.getItem(NOTIFY_SOUND_KEY) !== '0'
  )
  const notifySoundRef = useRef(notifySound)
  notifySoundRef.current = notifySound

  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => saveTerminalPaletteChoice(themeChoice), [themeChoice])
  useEffect(() => applyChromeTheme(chromeTheme), [chromeTheme])
  useEffect(() => localStorage.setItem(FONT_KEY, String(fontSize)), [fontSize])
  useEffect(
    () => localStorage.setItem(TERMINAL_LINE_HEIGHT_KEY, String(terminalLineHeight)),
    [terminalLineHeight]
  )
  useEffect(
    () => localStorage.setItem(TERMINAL_CURSOR_BLINK_KEY, terminalCursorBlink ? '1' : '0'),
    [terminalCursorBlink]
  )
  useEffect(
    () => localStorage.setItem(TERMINAL_SCROLLBACK_KEY, String(terminalScrollbackLines)),
    [terminalScrollbackLines]
  )
  useEffect(() => localStorage.setItem(FONT_FAMILY_KEY, fontFamilyId), [fontFamilyId])
  useEffect(
    () => localStorage.setItem(SHIFT_ENTER_KEY, shiftEnterNewline ? '1' : '0'),
    [shiftEnterNewline]
  )
  useEffect(
    () => localStorage.setItem(LINKS_IN_PANE_KEY, openLinksInPane ? '1' : '0'),
    [openLinksInPane]
  )
  useEffect(() => localStorage.setItem(WS_COLORS_KEY, JSON.stringify(wsColors)), [wsColors])
  useEffect(() => localStorage.setItem(WS_ORDER_KEY, JSON.stringify(wsOrder)), [wsOrder])
  useEffect(() => localStorage.setItem(WS_PINNED_KEY, JSON.stringify(wsPinned)), [wsPinned])
  useEffect(
    () => localStorage.setItem(SHELLINT_KEY, shellIntegration ? '1' : '0'),
    [shellIntegration]
  )
  useEffect(() => localStorage.setItem(OSC52_KEY, osc52 ? '1' : '0'), [osc52])
  useEffect(
    () => localStorage.setItem(COPY_ON_SELECT_KEY, copyOnSelect ? '1' : '0'),
    [copyOnSelect]
  )
  useEffect(
    () => localStorage.setItem(STRIP_BOX_GLYPHS_KEY, stripBoxGlyphs ? '1' : '0'),
    [stripBoxGlyphs]
  )
  useEffect(() => localStorage.setItem(NOTIFY_KEY, notifyEnabled ? '1' : '0'), [notifyEnabled])
  useEffect(() => saveNotifyKinds(notifyKinds), [notifyKinds])
  useEffect(
    () => localStorage.setItem(NOTIFY_SOUND_KEY, notifySound ? '1' : '0'),
    [notifySound]
  )
  useEffect(() => {
    void setZoomFactor(uiZoom).catch((err: unknown) => {
      console.warn('houston: setZoomFactor failed', err)
    })
    document.documentElement.style.setProperty('--shell-zoom', String(uiZoom))
    localStorage.setItem(ZOOM_KEY, String(uiZoom))
  }, [uiZoom])

  const changeFont = useCallback((dir: 1 | -1 | 0) => {
    setFontSize((s) => (dir === 0 ? FONT_DEFAULT : Math.min(FONT_MAX, Math.max(FONT_MIN, s + dir))))
  }, [])

  const changeZoom = useCallback((dir: 1 | -1 | 0) => {
    setUiZoom((z) =>
      dir === 0
        ? 1
        : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + dir * ZOOM_STEP) * 10) / 10))
    )
  }, [])

  return {
    theme,
    themeChoice,
    setTheme,
    chromeTheme,
    setChromeTheme,
    chromeMigrationNotice,
    chromeMigrationNoticeDismissed,
    setChromeMigrationNoticeDismissed,
    fontSize,
    setFontSize,
    terminalLineHeight,
    setTerminalLineHeight,
    terminalCursorBlink,
    setTerminalCursorBlink,
    terminalScrollbackLines,
    setTerminalScrollbackLines,
    uiZoom,
    setUiZoom,
    shiftEnterNewline,
    setShiftEnterNewline,
    openLinksInPane,
    setOpenLinksInPane,
    fontFamilyId,
    setFontFamilyId,
    fontFamily,
    wsColors,
    setWsColors,
    wsOrder,
    setWsOrder,
    wsPinned,
    setWsPinned,
    shellIntegration,
    setShellIntegration,
    osc52,
    setOsc52,
    osc52Ref,
    copyOnSelect,
    setCopyOnSelect,
    stripBoxGlyphs,
    setStripBoxGlyphs,
    notifyEnabled,
    setNotifyEnabled,
    notifyEnabledRef,
    notifyKinds,
    setNotifyKinds,
    notifyKindsRef,
    notifySound,
    setNotifySound,
    notifySoundRef,
    changeFont,
    changeZoom
  }
}
