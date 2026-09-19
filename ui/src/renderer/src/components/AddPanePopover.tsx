import { useEffect, useState } from 'react'
import type { AgentKind } from '../houston/client'
import { PANE_TYPES, paneTypeButtonState } from '../layout/paneTypes'
import { effectiveLabel, newBrowserPane, newTerminal } from '../keymap'
import type { KeymapOverrides } from '../houston/client'
import type { AgentProfileState } from './SettingsView'
import type { ProfileChoice } from '../houston/generated/ProfileChoice'
import {
  IconAgent,
  IconChevronRight,
  IconGrid,
  IconSparkles,
  IconSplitDown,
  IconSquareTerminal
} from './icons'
import { ICON_ROLE_CLS, Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { OVERLAY_GLASS_OVERLAY_ATTRS, OVERLAY_GLASS_OVERLAY_CLS, popOriginStyle } from './overlayChrome'

// Only the agents spawnable via `hs-pane`/handoff today, not the full
// `AgentKind` union (shell/custom/ssh/the ACP long tail are not offered here).
const POPOVER_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok']

const AGENT_DOT_COLOR: Partial<Record<AgentKind, string>> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  antigravity: 'var(--antigravity)',
  opencode: 'var(--opencode)',
  cursor: 'var(--cursor)',
  grok: 'var(--grok)'
}

// Tooltip's wrapper shrink-wraps when given no class, so a wrapped disabled
// row needs this to fill the popover width like its enabled siblings.
const FULL_WIDTH_TOOLTIP_CLS = 'inline-flex w-full'

export interface AddPanePopoverProps {
  right: number
  y: number
  hasWorkspace: boolean
  keymapOverrides: KeymapOverrides
  onClose: () => void
  onInsertPane: (kind: 'browser' | 'files') => void
  onNewTerminal: () => void
  onSpawnAgent: (agent: AgentKind, profile?: ProfileChoice) => void
  onSplitDown?: () => void
  onNewGrid: () => void
  onNewSession: () => void
  agentProfiles: AgentProfileState | null
}

export function AddPanePopover({
  right,
  y,
  hasWorkspace,
  keymapOverrides,
  onClose,
  onInsertPane,
  onNewTerminal,
  onSpawnAgent,
  onSplitDown,
  onNewGrid,
  onNewSession,
  agentProfiles
}: AddPanePopoverProps): React.JSX.Element {
  const [expandedProfileAgent, setExpandedProfileAgent] = useState<AgentKind | null>(null)

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const insertable = PANE_TYPES.filter((t) => t.insertable)

  return (
    <div
      data-testid="add-pane-popover"
      {...OVERLAY_GLASS_OVERLAY_ATTRS}
      className={`add-pane-popover fixed z-[var(--z-popover)] flex flex-col gap-0.5 py-1.5 min-w-[220px] overflow-hidden ${OVERLAY_GLASS_OVERLAY_CLS}`}
      // right-edge anchored: `right` is already the button's own right edge,
      // so the popover opens leftward and can never clip off the right of the screen.
      style={{ top: y, right, ...popOriginStyle('right', 'top') }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 pt-1 pb-0.5 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">
        New pane
      </div>
      <button
        className="flex items-center gap-2.5 px-3 min-h-[var(--h-ctl)] text-left bg-transparent border-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]"
        onClick={() => {
          onClose()
          onNewTerminal()
        }}
      >
        <Icon glyph={IconSquareTerminal} role="ui" className="text-[var(--text-muted)] flex-none" />
        <span className="flex-1">Terminal</span>
        <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] font-mono text-[var(--text-faint)]">
          {effectiveLabel(newTerminal, keymapOverrides)}
        </span>
      </button>
      {insertable.map((t) => {
        const state = paneTypeButtonState(t, hasWorkspace)
        const disabled = state.disabled || !hasWorkspace
        const title = hasWorkspace ? state.title : `Open a workspace to use ${t.label}`
        const shortcut =
          t.kind === 'browser' ? effectiveLabel(newBrowserPane, keymapOverrides) : undefined
        return (
          <Tooltip key={t.kind} label={title} className={disabled ? FULL_WIDTH_TOOLTIP_CLS : undefined}>
            <button
              data-pane-kind={t.kind}
              disabled={disabled}
              className={`flex items-center gap-2.5 px-3 min-h-[var(--h-ctl)]${disabled ? ' w-full' : ''} text-left bg-transparent border-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent`}
              onClick={() => {
                if (disabled) return
                onClose()
                onInsertPane(t.kind as 'browser' | 'files')
              }}
            >
              <span className="text-[var(--text-muted)] flex-none inline-flex">
                <t.Icon className={ICON_ROLE_CLS.ui} />
              </span>
              <span className="flex-1">{t.label}</span>
              {shortcut && <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] font-mono text-[var(--text-faint)]">{shortcut}</span>}
            </button>
          </Tooltip>
        )
      })}
      <div className="h-px my-1 mx-0 bg-[var(--glass-brd)]" />
      <div className="px-3 pt-1 pb-0.5 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">
        Agent
      </div>
      {POPOVER_AGENTS.map((agent) => {
        const profiles = agentProfiles?.profiles.filter((p) => p.agent === agent) ?? []
        if (profiles.length === 0) {
          return (
            <Tooltip
              key={agent}
              label={hasWorkspace ? undefined : 'Open a workspace to spawn an agent'}
              className={FULL_WIDTH_TOOLTIP_CLS}
            >
              <button
                disabled={!hasWorkspace}
                className="flex items-center gap-2.5 px-3 min-h-[var(--h-ctl)] w-full text-left bg-transparent border-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={() => {
                  if (!hasWorkspace) return
                  onClose()
                  onSpawnAgent(agent)
                }}
              >
                <span style={{ color: AGENT_DOT_COLOR[agent] ?? 'var(--text-muted)' }} className="flex-none inline-flex">
                  <IconAgent agent={agent} className={ICON_ROLE_CLS.ui} />
                </span>
                <span className="flex-1 capitalize">{agent}</span>
              </button>
            </Tooltip>
          )
        }
        const expanded = expandedProfileAgent === agent
        return (
          <div key={agent}>
            <Tooltip
              label={hasWorkspace ? undefined : 'Open a workspace to spawn an agent'}
              className={FULL_WIDTH_TOOLTIP_CLS}
            >
              <button
                disabled={!hasWorkspace}
                className="flex items-center gap-2.5 px-3 min-h-[var(--h-ctl)] w-full text-left bg-transparent border-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={() => {
                  if (!hasWorkspace) return
                  setExpandedProfileAgent(expanded ? null : agent)
                }}
              >
                <span style={{ color: AGENT_DOT_COLOR[agent] ?? 'var(--text-muted)' }} className="flex-none inline-flex">
                  <IconAgent agent={agent} className={ICON_ROLE_CLS.ui} />
                </span>
                <span className="flex-1 capitalize">{agent}</span>
                <Icon
                  glyph={IconChevronRight}
                  role="ui"
                  className={`text-[var(--text-faint)] flex-none transition-transform ${expanded ? 'rotate-90' : ''}`}
                />
              </button>
            </Tooltip>
            {expanded && (
              <div className="flex flex-col gap-0.5 py-0.5">
                <button
                  className="flex items-center gap-2.5 pl-8 pr-3 min-h-[var(--h-pill)] text-left bg-transparent border-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]"
                  onClick={() => {
                    onClose()
                    onSpawnAgent(agent, { kind: 'default' })
                  }}
                >
                  Default account
                </button>
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    className="flex items-center gap-2.5 pl-8 pr-3 min-h-[var(--h-pill)] text-left bg-transparent border-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]"
                    onClick={() => {
                      onClose()
                      onSpawnAgent(agent, { kind: 'profile', id: p.id })
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div className="h-px my-1 mx-0 bg-[var(--glass-brd)]" />
      <Tooltip label={onSplitDown ? undefined : 'No focused pane to split'} className={FULL_WIDTH_TOOLTIP_CLS}>
        <button
          disabled={!onSplitDown}
          className="flex items-center gap-2.5 px-3 min-h-[var(--h-ctl)] w-full text-left bg-transparent border-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
          onClick={() => {
            if (!onSplitDown) return
            onClose()
            onSplitDown()
          }}
        >
          <span className="text-[var(--text-muted)] flex-none inline-flex">
            <Icon glyph={IconSplitDown} role="ui" />
          </span>
          <span className="flex-1">Split down</span>
        </button>
      </Tooltip>
      <Tooltip label={hasWorkspace ? undefined : 'Open a workspace to add a tab'} className={FULL_WIDTH_TOOLTIP_CLS}>
        <button
          data-testid="add-pane-new-tab"
          disabled={!hasWorkspace}
          className="flex items-center gap-2.5 px-3 min-h-[var(--h-ctl)] w-full text-left bg-transparent border-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
          onClick={() => {
            if (!hasWorkspace) return
            onClose()
            onNewGrid()
          }}
        >
          <span className="text-[var(--text-muted)] flex-none inline-flex">
            <Icon glyph={IconGrid} role="ui" />
          </span>
          <span className="flex-1">New tab</span>
        </button>
      </Tooltip>
      <Tooltip label={hasWorkspace ? undefined : 'Open a workspace to start a session'} className={FULL_WIDTH_TOOLTIP_CLS}>
        <button
          data-testid="add-pane-new-session"
          disabled={!hasWorkspace}
          className="flex items-center gap-2.5 px-3 min-h-[var(--h-ctl)] w-full text-left bg-transparent border-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
          onClick={() => {
            if (!hasWorkspace) return
            onClose()
            onNewSession()
          }}
        >
          <Icon glyph={IconSparkles} role="ui" className="text-[var(--text-muted)] flex-none" />
          <span className="flex-1">New session…</span>
        </button>
      </Tooltip>
    </div>
  )
}
