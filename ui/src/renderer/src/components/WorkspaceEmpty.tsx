import { IconGlobe, IconSparkles, IconSquareTerminal } from './icons'
import { Icon } from './ui/Icon'
import { WorkspaceActions } from './ui/WorkspaceActions'
import { Button, Card, EmptyStateFrame, EmptyStateActions, EmptyStateHeading, EmptyStateDescription } from './ui'
import type { WorkspaceAction } from '../houston/client'
import type { KeymapOverrides } from '../houston/client'

export interface WorkspaceEmptyProps {
  onNewSession: () => void
  onTerminal: () => void
  onBrowser: () => void
  actions?: WorkspaceAction[]
  keymapOverrides?: KeymapOverrides
  onRunAction?: (action: WorkspaceAction) => void
  onSaveAction?: (action: WorkspaceAction) => void
  onDeleteAction?: (id: string) => void
}

export function WorkspaceEmpty({
  onNewSession,
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
      <EmptyStateHeading
        data-testid="workspace-empty-headline"
      >
        Nothing running here yet
      </EmptyStateHeading>
      <EmptyStateDescription>
        Open a real terminal or an isolated browser inside this workspace.
      </EmptyStateDescription>
      <EmptyStateActions>
        <Button
          variant="action-primary"
          size="lg"
          data-testid="workspace-empty-new-session"
          onClick={onNewSession}
          className=""
        >
          <Icon glyph={IconSparkles} role="ui" />
          New session
        </Button>
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
      <WorkspaceActions actions={actions} keymapOverrides={keymapOverrides} onRun={onRunAction} onSave={onSaveAction} onDelete={onDeleteAction} />
      </Card>
    </EmptyStateFrame>
  )
}
