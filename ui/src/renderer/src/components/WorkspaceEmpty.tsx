import { MascotSurfaceMount } from '../mascot/MascotMount'
import { IconGlobe, IconSquareTerminal } from './icons'
import { Icon } from './ui/Icon'
import { WorkspaceActions } from './ui/WorkspaceActions'
import { Button, Card, Inline, EmptyStateFrame, EmptyStateActions, EmptyStateHeading, EmptyStateDescription } from './ui'
import type { WorkspaceAction } from '../houston/client'
import { PaneMenuAgentRow } from './ui/PaneMenu'
import type { AgentKind } from '../houston/client'
import type { KeymapOverrides } from '../houston/client'

export interface WorkspaceEmptyProps {
  installedAgents: AgentKind[]
  onSpawnAgent: (agent: AgentKind) => void
  onTerminal: () => void
  onBrowser: () => void
  actions?: WorkspaceAction[]
  keymapOverrides?: KeymapOverrides
  onRunAction?: (action: WorkspaceAction) => void
  onSaveAction?: (action: WorkspaceAction) => void
  onDeleteAction?: (id: string) => void
}

export function WorkspaceEmpty({
  installedAgents,
  onSpawnAgent,
  onTerminal,
  onBrowser,
  actions = [],
  keymapOverrides = { bindings: {}, shortcuts_enabled: true },
  onRunAction = () => {},
  onSaveAction = () => {},
  onDeleteAction = () => {}
}: WorkspaceEmptyProps): React.JSX.Element {
  return (
    <EmptyStateFrame
      data-testid="workspace-empty"
      className=""
    >
      {}
      <Card
        data-testid="workspace-empty-plate"
        tone="plate"
        shape="card"
        padding="roomy"
        layout="center-stack"
        clip={false}
        className=""
      >
      <MascotSurfaceMount />
      <EmptyStateHeading
        data-testid="workspace-empty-headline"
      >
        Nothing running here yet
      </EmptyStateHeading>
      <EmptyStateDescription>
        Open a terminal or an installed agent inside this workspace.
      </EmptyStateDescription>
      <EmptyStateActions>
        <Button
          variant="surface-large"
          data-testid="workspace-empty-terminal"
          onClick={onTerminal}
          className=""
        >
          <Icon glyph={IconSquareTerminal} role="ui" />
          Terminal
        </Button>
        <Button
          variant="surface-large"
          data-testid="workspace-empty-browser"
          onClick={onBrowser}
          className=""
        >
          <Icon glyph={IconGlobe} role="ui" />
          Browser
        </Button>
      </EmptyStateActions>
      <Inline gap="small" wrap className="justify-center">
        {installedAgents.filter((agent) => ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok', 'zcode'].includes(agent)).map((agent) => (
          <div key={agent}><PaneMenuAgentRow agent={agent} onClick={() => onSpawnAgent(agent)} /></div>
        ))}
      </Inline>
      <WorkspaceActions actions={actions} keymapOverrides={keymapOverrides} onRun={onRunAction} onSave={onSaveAction} onDelete={onDeleteAction} />
      </Card>
    </EmptyStateFrame>
  )
}
