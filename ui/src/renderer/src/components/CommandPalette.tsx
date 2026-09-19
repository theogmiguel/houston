import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  APPEARANCE_PICKER_COMMAND_ID,
  buildCommands,
  filterCommands,
  type BuildCommandsInput,
  type Command,
  type CommandGroup
} from './commandRegistry'
import { AppearancePicker } from './AppearancePicker'
import { effectiveLabel, escapeShortcut } from '../keymap'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { IconSearch } from './icons'
import type { ThemeName } from '../theme'
import { Icon } from './Icon'
import { FOCUS_HALO } from './shadowChrome'
import { MATERIAL_CLS, materialAttrs } from './material'

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

const GROUP_ORDER: CommandGroup[] = [
  'Tabs',
  'Panes',
  'Agents',
  'Grid',
  'View',
  'Window',
  'Go to',
  'Appearance',
  'Workspaces'
]

function groupCommands(commands: readonly Command[]): { group: CommandGroup; items: Command[] }[] {
  const byGroup = new Map<CommandGroup, Command[]>()
  for (const c of commands) {
    const arr = byGroup.get(c.group)
    if (arr) arr.push(c)
    else byGroup.set(c.group, [c])
  }
  return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ group: g, items: byGroup.get(g) as Command[] }))
}

export function CommandPalette({
  onClose,
  actions,
  hasWorkspace,
  workspaces,
  appearance
}: CommandPaletteProps): React.JSX.Element {
  const keymapOverrides = useContext(KeymapOverridesContext)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>('list')
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<Element | null>(null)

  const commands = useMemo(
    () => buildCommands({ actions, hasWorkspace, workspaces }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasWorkspace, workspaces]
  )
  const filtered = query.trim() ? filterCommands(commands, query) : commands
  const groups = query.trim() ? null : groupCommands(filtered)
  const navigable = filtered.filter((c) => c.enabled)

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

  const runHighlighted = (): void => {
    const cmd = navigable.find((c) => c.id === highlightedId)
    if (!cmd) return
    if (cmd.id === APPEARANCE_PICKER_COMMAND_ID) {
      setView('appearance')
      return
    }
    cmd.run()
    onClose()
  }

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
    const chordLabel = cmd.chord ? effectiveLabel(cmd.chord, keymapOverrides) : null
    return (
      <div
        key={cmd.id}
        data-testid="command-palette-row"
        data-command-id={cmd.id}
        id={`command-palette-row-${cmd.id}`}
        role="option"
        aria-selected={selected}
        aria-disabled={!cmd.enabled}
        className={`flex items-center gap-2.5 px-4 min-h-[32px] py-1 cursor-pointer ${
          cmd.enabled ? '' : 'cursor-default opacity-60'
        } ${selected && cmd.enabled ? 'bg-[var(--accent-muted)]' : ''}`}
        onMouseEnter={() => {
          if (cmd.enabled) setHighlightedId(cmd.id)
        }}
        onClick={() => {
          if (!cmd.enabled) return
          setHighlightedId(cmd.id)
          runHighlighted()
        }}
      >
        <div className="min-w-0 flex-1">
          <div
            className={`[font-size:var(--tr-text-ui-size)] font-medium truncate ${
              selected && cmd.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            {cmd.title}
          </div>
          {!cmd.enabled && cmd.disabledReason && (
            <div data-testid="command-palette-row-reason" className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)] truncate">
              {cmd.disabledReason}
            </div>
          )}
        </div>
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
        className={`w-[min(560px,86vw)] max-h-[70vh] flex flex-col rounded-[var(--tr-radius-md)] overflow-hidden ${MATERIAL_CLS['overlay-glass']} motion-safe:animate-[menu-in_var(--animate-t-fast)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards]`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {view === 'list' ? (
          <>
            <div className="flex items-center gap-2.5 px-4 h-[46px] border-b border-[var(--glass-brd)] flex-none">
              <Icon glyph={IconSearch} role="subhead" />
              <input
                ref={searchRef}
                data-testid="command-palette-search"
                aria-label="Search commands, panes, workspaces"
                placeholder="Search actions, panes, workspaces…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onListKeyDown}
                className={`flex-1 min-w-0 bg-transparent border-0 outline-none focus-visible:shadow-[${FOCUS_HALO}] rounded-[4px] [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)]`}
              />
              <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] font-mono text-[var(--text-faint)] border border-[var(--glass-brd)] rounded px-1.5 py-0.5">
                {escapeShortcut.keyLabel.toUpperCase()}
              </span>
            </div>
            <div
              data-testid="command-palette-list"
              role="listbox"
              aria-label="Commands"
              className="flex-1 overflow-y-auto py-1.5"
            >
              {filtered.length === 0 ? (
                <div data-testid="command-palette-empty-set" className="py-8 text-center [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
                  No commands match &quot;{query}&quot;
                </div>
              ) : groups ? (
                groups.map(({ group, items }) => (
                  <div key={group}>
                    <div
                      data-testid="command-palette-group"
                      className="px-4 pt-2.5 pb-1 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]"
                    >
                      {group}
                    </div>
                    {items.map(renderRow)}
                  </div>
                ))
              ) : (
                filtered.map(renderRow)
              )}
            </div>
          </>
        ) : (
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
        )}
      </div>
    </div>
  )
}
