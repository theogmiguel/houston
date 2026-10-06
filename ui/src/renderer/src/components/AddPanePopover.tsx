import { useEffect, useState } from 'react'
import type { AgentKind } from '../houston/client'
import { effectiveLabel, newBrowserPane, newTerminal } from '../keymap'
import type { KeymapOverrides } from '../houston/client'
import type { AgentProfileState } from './SettingsView'
import type { ProfileChoice } from '../houston/generated/ProfileChoice'
import type { WorkspaceAction } from '../houston/client'
import { PaneMenuRow } from './ui/PaneMenuRow'
import { WorkspaceActions } from './ui/WorkspaceActions'
import {
  AGENT_DOT_COLOR,
  IconAgent,
  IconChevronRight,
  IconGlobe,
  IconGrid,
  IconSplitDown,
  IconSquareTerminal
} from './icons'
import { ICON_ROLE_CLS, Icon } from './ui/Icon'
import { Tooltip } from './ui/Tooltip'
import { OVERLAY_GLASS_OVERLAY_ATTRS, OVERLAY_GLASS_OVERLAY_CLS, popOriginStyle } from './ui/overlayChrome'

// Only the agents spawnable via `hs-pane`/handoff today, not the full
// `AgentKind` union (shell/custom/ssh/the ACP long tail are not offered here).
const POPOVER_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok']

// Tooltip's wrapper shrink-wraps when given no class, so a wrapped disabled
// row needs this to fill the popover width like its enabled siblings.
const FULL_WIDTH_TOOLTIP_CLS = 'inline-flex w-full'

export interface AddPanePopoverProps {
  right: number
  y: number
  hasWorkspace: boolean
  keymapOverrides: KeymapOverrides
  onClose: () => void
  onNewTerminal: () => void
  onNewBrowser: () => void
  onSpawnAgent: (agent: AgentKind, profile?: ProfileChoice) => void
  onSplitDown?: () => void
  onNewGrid: () => void
  agentProfiles: AgentProfileState | null
  workspaceActions?: WorkspaceAction[]
  onRunWorkspaceAction?: (action: WorkspaceAction) => void
  onSaveWorkspaceAction?: (action: WorkspaceAction) => void
  onDeleteWorkspaceAction?: (id: string) => void
}

export function AddPanePopover({
  right,
  y,
  hasWorkspace,
  keymapOverrides,
  onClose,
  onNewTerminal,
  onNewBrowser,
  onSpawnAgent,
  onSplitDown,
  onNewGrid,
  agentProfiles,
  workspaceActions = [],
  onRunWorkspaceAction = () => {},
  onSaveWorkspaceAction = () => {},
  onDeleteWorkspaceAction = () => {}
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
      <PaneMenuRow
        icon={IconSquareTerminal}
        label="Terminal"
        shortcut={effectiveLabel(newTerminal, keymapOverrides)}
        onClick={() => {
          onClose()
          onNewTerminal()
        }}
      />
      <PaneMenuRow
        data-testid="add-pane-browser"
        icon={IconGlobe}
        label="Browser"
        shortcut={effectiveLabel(newBrowserPane, keymapOverrides)}
        disabledReason={hasWorkspace ? undefined : 'Open a workspace to open a browser'}
        onClick={() => {
          onClose()
          onNewBrowser()
        }}
      />
      {hasWorkspace && (
        <WorkspaceActions
          variant="menu"
          actions={workspaceActions}
          keymapOverrides={keymapOverrides}
          onRun={(action) => { onClose(); onRunWorkspaceAction(action) }}
          onSave={onSaveWorkspaceAction}
          onDelete={onDeleteWorkspaceAction}
        />
      )}
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
    </div>
  )
}
