import { useEffect, useState } from 'react'
import type { AgentKind } from '../houston/client'
import { effectiveLabel, newBrowserPane, newTerminal } from '../keymap'
import type { KeymapOverrides } from '../houston/client'
import type { AgentProfileState } from './SettingsView'
import type { ProfileChoice } from '../houston/generated/ProfileChoice'
import type { WorkspaceAction } from '../houston/client'
import { PaneMenuRow } from './ui/PaneMenuRow'
import { PaneMenuAgentRow, PaneMenuDivider, PaneMenuLabel, PaneMenuProfileGroup, PaneMenuProfileRow, PaneMenuSurface } from './ui/PaneMenu'
import { WorkspaceActions } from './ui/WorkspaceActions'
import { IconGlobe, IconGrid, IconSplitDown, IconSquareTerminal } from './icons'

// Only the agents spawnable via `hs-pane`/handoff today, not the full
// `AgentKind` union (shell/custom/ssh/the ACP long tail are not offered here).
const POPOVER_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok']

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
    <PaneMenuSurface
      data-testid="add-pane-popover"
      // right-edge anchored: `right` is already the button's own right edge,
      // so the popover opens leftward and can never clip off the right of the screen.
      right={right}
      y={y}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <PaneMenuLabel>New pane</PaneMenuLabel>
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
      <PaneMenuDivider />
      <PaneMenuLabel>Agent</PaneMenuLabel>
      {POPOVER_AGENTS.map((agent) => {
        const profiles = agentProfiles?.profiles.filter((p) => p.agent === agent) ?? []
        const disabledReason = hasWorkspace ? undefined : 'Open a workspace to spawn an agent'
        if (profiles.length === 0) {
          return (
            <PaneMenuAgentRow
              key={agent}
              agent={agent}
              disabledReason={disabledReason}
              onClick={() => {
                onClose()
                onSpawnAgent(agent)
              }}
            />
          )
        }
        const expanded = expandedProfileAgent === agent
        return (
          <div key={agent}>
            <PaneMenuAgentRow
              agent={agent}
              expanded={expanded}
              disabledReason={disabledReason}
              onClick={() => setExpandedProfileAgent(expanded ? null : agent)}
            />
            {expanded && (
              <PaneMenuProfileGroup>
                <PaneMenuProfileRow
                  onClick={() => {
                    onClose()
                    onSpawnAgent(agent, { kind: 'default' })
                  }}
                >
                  Default account
                </PaneMenuProfileRow>
                {profiles.map((p) => (
                  <PaneMenuProfileRow
                    key={p.id}
                    onClick={() => {
                      onClose()
                      onSpawnAgent(agent, { kind: 'profile', id: p.id })
                    }}
                  >
                    {p.name}
                  </PaneMenuProfileRow>
                ))}
              </PaneMenuProfileGroup>
            )}
          </div>
        )
      })}
      <PaneMenuDivider />
      <PaneMenuRow
        icon={IconSplitDown}
        label="Split down"
        disabledReason={onSplitDown ? undefined : 'No focused pane to split'}
        onClick={() => {
          onClose()
          onSplitDown?.()
        }}
      />
      <PaneMenuRow
        data-testid="add-pane-new-tab"
        icon={IconGrid}
        label="New tab"
        disabledReason={hasWorkspace ? undefined : 'Open a workspace to add a tab'}
        onClick={() => {
          onClose()
          onNewGrid()
        }}
      />
    </PaneMenuSurface>
  )
}
