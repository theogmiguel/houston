import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  APPEARANCE_PICKER_COMMAND_ID,
  buildCommands,
  filterCommands,
  type BuildCommandsInput,
  type Command
} from '../commandRegistry'
import { escapeShortcut } from '../../keymap'
import { KeymapOverridesContext } from '../../layout/keymapOverridesContext'
import { IconSearch } from '../icons'
import type { ThemeName } from '../../theme'
import { Icon } from '../Icon'
import { FOCUS_HALO } from '../shadowChrome'
import { MATERIAL_CLS, materialAttrs } from '../material'
import { groupPaletteCommands, PALETTE_RECENTS_KEY, paletteShortcutLabels, readPaletteRecents, rememberPaletteCommand, sessionDotClass } from './commandPalette'
import { variants } from './variants'

export interface AppearanceEmbed {
  currentTheme: ThemeName
  onPreview: (t: ThemeName) => void
  onCommit: (t: ThemeName) => void
}

export interface CommandPaletteProps extends BuildCommandsInput {
  onClose: () => void
  appearance: AppearanceEmbed
}

type View = 'list' | 'appearance'

const AppearancePicker = lazy(() => import('../AppearancePicker').then((module) => ({ default: module.AppearancePicker })))

const palettePanel = variants('w-[min(560px,86vw)] max-h-[70vh] flex flex-col overflow-hidden', {
  surface: { glass: `rounded-[var(--tr-radius-button)] ${MATERIAL_CLS['overlay-glass']}` }
}, { surface: 'glass' })
const paletteRow = variants('flex items-center gap-[var(--space-2)] px-2.5 min-h-[var(--h-row)] cursor-pointer', {
  state: { selected: 'bg-[var(--accent-muted)]', regular: '', disabled: 'h-auto py-1 cursor-default opacity-60' }
}, { state: 'regular' })

export function CommandPalette({
  onClose,
  actions,
  hasWorkspace,
  workspaces,
  appearance,
  sessions = [],
  activeSessionId = null
}: CommandPaletteProps): React.JSX.Element {
  const keymapOverrides = useContext(KeymapOverridesContext)
  const [recentIds, setRecentIds] = useState(() => readPaletteRecents(window.localStorage))
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>('list')
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<Element | null>(null)

  const commands = useMemo(
    () => buildCommands({ actions, hasWorkspace, workspaces, sessions, activeSessionId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasWorkspace, workspaces, sessions, activeSessionId]
  )
  const filtered = query.trim() ? filterCommands(commands, query) : commands
  const groups = query.trim() ? null : groupPaletteCommands(filtered, recentIds)
  const visibleCommands = query.trim() ? filtered : groups?.flatMap((group) => group.items) ?? []
  const navigable = visibleCommands.filter((c) => c.enabled)
  const shortcutLabels = paletteShortcutLabels(commands, keymapOverrides)

  useEffect(() => {
    triggerRef.current = document.activeElement
    searchRef.current?.focus()
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (highlightedId !== null && navigable.some((c) => c.id === highlightedId)) return
    setHighlightedId(navigable[0]?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, commands])

  useEffect(() => {
    if (view !== 'appearance') return
    const input = containerRef.current?.querySelector<HTMLInputElement>('[data-testid="appearance-picker-search"]')
    input?.focus()
  }, [view])

  const runCommand = (cmd: Command | undefined): void => {
    if (!cmd) return
    if (cmd.id === APPEARANCE_PICKER_COMMAND_ID) {
      setView('appearance')
      return
    }
    const nextRecentIds = rememberPaletteCommand(recentIds, cmd.id)
    setRecentIds(nextRecentIds)
    window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(nextRecentIds))
    cmd.run()
    onClose()
  }

  const runHighlighted = (): void => runCommand(navigable.find((c) => c.id === highlightedId))

  const moveHighlight = (delta: 1 | -1): void => {
    if (navigable.length === 0) return
    const idx = navigable.findIndex((c) => c.id === highlightedId)
    const next = navigable[(idx + delta + navigable.length) % navigable.length]
    setHighlightedId(next?.id ?? null)
  }

  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveHighlight(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveHighlight(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runHighlighted()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (view === 'appearance') {
        setView('list')
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, onClose])

  const renderRow = (cmd: Command): React.JSX.Element => {
    const selected = cmd.id === highlightedId
    const chordLabel = shortcutLabels[cmd.id]
    return (
      <div
        key={cmd.id}
        data-testid="command-palette-row"
        data-command-id={cmd.id}
        id={`command-palette-row-${cmd.id}`}
        role="option"
        aria-selected={selected}
        aria-disabled={!cmd.enabled}
        className={paletteRow({ state: !cmd.enabled ? 'disabled' : selected ? 'selected' : 'regular' })}
        onMouseEnter={() => {
          if (cmd.enabled) setHighlightedId(cmd.id)
        }}
        onClick={() => {
          if (!cmd.enabled) return
          setHighlightedId(cmd.id)
          runCommand(cmd)
        }}
      >
        {cmd.session && <span aria-hidden="true" className={`h-[7px] w-[7px] rounded-full flex-none ${sessionDotClass(cmd.session.status)}`} />}
        {cmd.session && <span aria-hidden="true" className="w-3 text-center text-[var(--text-secondary)]">{cmd.session.agent === 'claude' ? '✳' : cmd.session.agent === 'codex' ? '◇' : '•'}</span>}
        <div className="min-w-0 flex-1">
          <div
            className={`[font-size:var(--tr-text-ui-size)] font-medium truncate ${
              selected && cmd.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            {cmd.title}
          </div>
          {!cmd.session && !cmd.enabled && cmd.disabledReason && (
            <div data-testid="command-palette-row-reason" className="text-[length:var(--tr-text-small-size)] text-[var(--text-faint)] truncate">
              {cmd.disabledReason}
            </div>
          )}
        </div>
        {cmd.session && <span className="ml-auto text-[length:var(--tr-text-small-size)] text-[var(--text-faint)] truncate">{cmd.subtitle} · {cmd.session.status === 'needs-input' ? 'needs input' : cmd.session.status ?? 'idle'}</span>}
        {chordLabel && <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] font-mono text-[var(--text-faint)] flex-none">{chordLabel}</span>}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[var(--z-palette)] flex items-start justify-center pt-16 bg-overlay motion-safe:animate-[backdrop-in_var(--animate-t-scrim)_var(--animate-ease-scrim)] [.anim-out_&]:motion-safe:animate-[backdrop-out_var(--animate-t-scrim)_var(--animate-ease-scrim)_forwards]"
      onMouseDown={onClose}
    >
      <div
        ref={containerRef}
        data-testid="command-palette"
        role="dialog"
        aria-label="Command palette"
        {...materialAttrs('overlay-glass')}
        className={`${palettePanel()} motion-safe:animate-[menu-in_var(--animate-t-fast)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards]`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {view === 'list' ? (
          <>
            <div className="flex items-center gap-[var(--space-2)] px-2.5 h-[38px] border-b border-[var(--glass-brd)] flex-none">
              <Icon glyph={IconSearch} role="subhead" />
              <input
                ref={searchRef}
                data-testid="command-palette-search"
                aria-label="Search commands, panes, workspaces"
                placeholder="Search actions, panes, workspaces…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onListKeyDown}
                className={`flex-1 min-w-0 bg-transparent border-0 outline-none focus-visible:shadow-[${FOCUS_HALO}] rounded-[var(--tr-radius-input)] [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)]`}
              />
              <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] font-mono text-[var(--text-faint)] border border-[var(--glass-brd)] rounded px-1.5 py-0.5">
                {escapeShortcut.keyLabel.toUpperCase()}
              </span>
            </div>
            <div
              data-testid="command-palette-list"
              role="listbox"
              aria-label="Commands"
              className="flex-1 overflow-y-auto"
            >
              {filtered.length === 0 ? (
                <div data-testid="command-palette-empty-set" className="grid justify-items-center gap-2 py-8 text-center [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
                  <span>No commands match &quot;{query}&quot;</span>
                  <button type="button" onClick={() => setQuery('')} className="text-[var(--accent)]">Clear search</button>
                </div>
              ) : groups ? (
                groups.map(({ group, items }) => (
                  <div key={group}>
                    <div
                      data-testid="command-palette-group"
                      className="px-2.5 pt-1.5 pb-0.5 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]"
                    >
                      {group}
                    </div>
                    {items.filter((item) => visibleCommands.includes(item)).map(renderRow)}
                  </div>
                ))
              ) : (
                visibleCommands.map(renderRow)
              )}
            </div>
            <div className="flex items-center gap-3 border-t border-[var(--glass-brd)] px-2.5 py-[7px] text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">
              <span><kbd className="font-mono text-[var(--text-secondary)]">↑↓</kbd> Navigate</span>
              <span><kbd className="font-mono text-[var(--text-secondary)]">Enter</kbd> {visibleCommands.find((command) => command.id === highlightedId)?.session ? 'Focus pane' : 'Run command'}</span>
              <span><kbd className="font-mono text-[var(--text-secondary)]">Esc</kbd> Close</span>
            </div>
          </>
        ) : (
          <Suspense fallback={<div className="p-3" />}>
            <div className="p-3">
              <AppearancePicker
                currentTheme={appearance.currentTheme}
                onPreview={appearance.onPreview}
                onCommit={(t) => {
                  appearance.onCommit(t)
                  onClose()
                }}
              />
            </div>
          </Suspense>
        )}
      </div>
    </div>
  )
}
