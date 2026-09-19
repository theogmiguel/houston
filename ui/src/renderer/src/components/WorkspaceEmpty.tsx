import { BTN_PRIMARY } from './buttonChrome'
import { IconGlobe, IconSparkles, IconSquareTerminal } from './icons'
import { Icon } from './Icon'

export interface WorkspaceEmptyProps {
  onNewSession: () => void
  onTerminal: () => void
  onBrowser: () => void
}

const SECONDARY =
  'inline-flex h-9 items-center gap-2 rounded-[var(--tr-radius-button)] border border-[var(--border)] ' +
  'bg-[var(--card-bg)] px-[var(--space-4)] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-secondary)] ' +
  'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'

export function WorkspaceEmpty({
  onNewSession,
  onTerminal,
  onBrowser
}: WorkspaceEmptyProps): React.JSX.Element {
  return (
    <div
      data-testid="workspace-empty"
      className="flex-1 min-w-0 flex flex-col items-center justify-center p-[28px] text-center"
    >
      {}
      <div
        data-testid="workspace-empty-plate"
        className="flex flex-col items-center gap-[var(--space-4)] rounded-[var(--tr-radius-card)] bg-[var(--field-plate-bg)] p-[28px]"
      >
      <div
        data-testid="workspace-empty-headline"
        className="font-[family-name:var(--tr-text-display-family)] text-[length:var(--tr-text-display-size)] leading-[1.15] tracking-[-0.02em] text-[var(--text-primary)] max-w-[20ch]"
        style={{ fontWeight: 'var(--tr-text-display-weight)' }}
      >
        Nothing running here yet
      </div>
      <p className="m-0 max-w-[52ch] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.65] text-[var(--text-muted)]">
        Open a real terminal or an isolated browser inside this workspace.
      </p>
      <div className="mt-[var(--space-2)] flex flex-wrap items-center justify-center gap-[7px]">
        <button
          type="button"
          data-testid="workspace-empty-new-session"
          onClick={onNewSession}
          className={`btn ${BTN_PRIMARY} inline-flex h-9 items-center gap-2 rounded-[var(--tr-radius-button)] px-[var(--space-5)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)]`}
        >
          <Icon glyph={IconSparkles} role="ui" />
          New session
        </button>
        <button
          type="button"
          data-testid="workspace-empty-terminal"
          onClick={onTerminal}
          className={SECONDARY}
        >
          <Icon glyph={IconSquareTerminal} role="ui" />
          Terminal
        </button>
        <button
          type="button"
          data-testid="workspace-empty-browser"
          onClick={onBrowser}
          className={SECONDARY}
        >
          <Icon glyph={IconGlobe} role="ui" />
          Browser
        </button>
      </div>
      </div>
    </div>
  )
}
