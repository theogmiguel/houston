import type { AgentKind } from '../../houston/generated/AgentKind'
import { Icon } from './Icon'
import { Button } from './Button'
import type { FirstRunHookRow } from '../firstRunHooks'
import { IconAgent, IconCheck, IconSquareTerminal } from '../icons'

export type FirstRunStepState = 'done' | 'current' | 'skipped' | 'upcoming'

export interface FirstRunHooksStepProps {
  steps: ReadonlyArray<{ label: string; state: FirstRunStepState }>
  rows: FirstRunHookRow[]
  installCount: number
  disabledReason: string | null
  onSet: (provider: AgentKind, enabled: boolean) => void
  onInstallAll: () => void
  onSkip: () => void
}

function StepIndicator({ steps }: Pick<FirstRunHooksStepProps, 'steps'>): React.JSX.Element {
  return (
    <nav aria-label="Setup steps" data-testid="first-run-steps" className="flex items-center gap-[var(--space-2)] [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">
      {steps.map((step, index) => (
        <span key={step.label} className="contents">
          {index > 0 && <span aria-hidden="true" className="h-px w-[28px] bg-[var(--border)]" />}
          <span
            aria-current={step.state === 'current' ? 'step' : undefined}
            data-state={step.state}
            className={`inline-flex items-center gap-[var(--space-1-5)] ${step.state === 'current' ? 'font-[var(--tr-text-ui-weight)] text-[var(--text-primary)]' : ''} ${step.state === 'skipped' ? 'text-[var(--text-faint)]' : ''}`}
          >
            <span className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--border)] [font-size:var(--tr-text-small-size)] tabular-nums ${step.state === 'done' ? 'border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-[var(--ok)]' : ''} ${step.state === 'current' ? 'border-[var(--accent)] text-[var(--accent)]' : ''} ${step.state === 'skipped' ? 'border-dashed text-[var(--text-faint)]' : ''}`}>
              {step.state === 'done' ? <Icon glyph={IconCheck} role="small" /> : index + 1}
            </span>
            {step.label}{step.state === 'skipped' ? ' · Skipped' : ''}
          </span>
        </span>
      ))}
    </nav>
  )
}

function HookRow({ row, onSet }: {
  row: FirstRunHookRow
  onSet: (provider: AgentKind, enabled: boolean) => void
}): React.JSX.Element {
  const reporting = row.status === 'reporting'
  const absent = row.status === 'not-found'
  return (
    <div data-testid="first-run-hook-row" data-provider={row.provider} data-status={row.status} className={`flex flex-col gap-[var(--space-1)] border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] px-[14px] py-[var(--space-2-5)] first:border-t-0 ${absent ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
      <div className="flex min-h-[18px] items-center gap-[var(--space-2-5)] [font-size:var(--tr-text-ui-size)]">
        <span aria-hidden="true" className={`inline-flex w-[20px] flex-none items-center justify-center ${absent ? 'opacity-50' : ''}`}>
          <IconAgent agent={row.provider} brand />
        </span>
        <span className="font-[var(--tr-text-ui-weight)]">{row.name}</span>
        {row.version && <span className="font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)] tabular-nums">{row.version}</span>}
        <span className={`ml-auto inline-flex items-center gap-[var(--space-1)] whitespace-nowrap [font-size:var(--tr-text-small-size)] ${reporting ? 'text-[var(--ok)]' : 'text-[var(--text-faint)]'}`}>
          {reporting && <Icon glyph={IconCheck} role="small" />}
          {reporting ? 'Reporting' : absent ? 'Not found on PATH' : 'Silent'}
        </span>
        <span className="flex w-[96px] flex-none justify-end">
          {absent ? <span className="text-[var(--text-faint)]">—</span> : (
            <Button
              size="sm"
              variant={reporting ? 'danger' : 'secondary'}
              data-testid={`first-run-hook-${row.provider}`}
              aria-label={`${reporting ? 'Remove' : 'Install hooks'} for ${row.name}`}
              onClick={() => onSet(row.provider, !reporting)}
            >
              {reporting ? 'Remove' : 'Install hooks'}
            </Button>
          )}
        </span>
      </div>
      {row.error && <p data-testid={`first-run-hook-error-${row.provider}`} className="[font-size:var(--tr-text-small-size)] text-[var(--stop)]">{row.error}</p>}
    </div>
  )
}

export function FirstRunHooksStep({
  steps,
  rows,
  installCount,
  disabledReason,
  onSet,
  onInstallAll,
  onSkip
}: FirstRunHooksStepProps): React.JSX.Element {
  return (
    <main data-testid="first-run-hooks" className="flex h-full min-w-0 flex-1 items-center justify-center overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] bg-[var(--content-bg)] p-[28px] text-center">
      <section className="flex w-full max-w-[560px] flex-col items-center gap-[var(--space-5)]">
        <StepIndicator steps={steps} />
        <div className="flex w-full flex-col items-center gap-[var(--space-4-5)]">
          <div className="flex flex-col items-center gap-[var(--space-4)]">
            <span aria-hidden="true" className="inline-flex h-[50px] w-[50px] items-center justify-center rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)]">
              <Icon glyph={IconSquareTerminal} role="title" />
            </span>
            <div className="flex flex-col items-center gap-[var(--space-1-5)]">
              <h1 data-testid="first-run-hooks-headline" className="[font-size:var(--tr-text-xl)] [font-weight:var(--tr-text-subhead-weight)] tracking-[-0.01em] text-[var(--text-primary)]">Hook up your agents</h1>
              <p className="max-w-[470px] [font-size:var(--tr-text-small-size)] leading-[1.55] text-[var(--text-muted)]">Houston reads agent status from each CLI’s own lifecycle hooks, never from the screen. Install them for the CLIs you use and panes report Working, Needs input and Done; skip it and they run fine but stay silent.</p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-[var(--space-3)]">
            <div data-testid="first-run-hook-list" className="w-full overflow-hidden rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] text-left">
              {rows.map((row) => <HookRow key={row.provider} row={row} onSet={onSet} />)}
            </div>
            <p data-testid="first-run-hook-note" className="max-w-[470px] self-center [font-size:var(--tr-text-small-size)] leading-[1.5] text-[var(--text-faint)]">Each install writes the hook configuration the CLI requires. Settings › Agents explains what it writes and removes Houston’s hooks.</p>
          </div>
        </div>
        <footer className="flex w-full items-center gap-[var(--space-2)]">
          <span data-testid="first-run-step" className="[font-size:var(--tr-text-label-size)] tabular-nums text-[var(--text-muted)]">Step 3 of 3</span>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" data-testid="first-run-skip" onClick={onSkip}>Not now</Button>
          {disabledReason && <span data-testid="first-run-install-reason" className="max-w-[180px] text-right [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">{disabledReason}</span>}
          <Button size="sm" variant="primary" data-testid="first-run-install-all" disabled={installCount === 0} aria-describedby={disabledReason ? 'first-run-install-reason' : undefined} onClick={onInstallAll}>Install for {installCount} CLIs</Button>
        </footer>
      </section>
    </main>
  )
}

export function FirstRunHooksStepSpecimen(): React.JSX.Element {
  const rows: FirstRunHookRow[] = [
    { provider: 'claude', name: 'Claude Code', version: '2.3.1', status: 'reporting', error: null },
    { provider: 'codex', name: 'Codex', version: '0.98.0', status: 'silent', error: null },
    { provider: 'opencode', name: 'OpenCode', version: '1.4.2', status: 'silent', error: null },
    { provider: 'grok', name: 'Grok', version: '0.6.0', status: 'silent', error: null },
    { provider: 'cursor', name: 'Cursor', version: null, status: 'not-found', error: null },
    { provider: 'antigravity', name: 'Antigravity', version: null, status: 'not-found', error: null }
  ]
  return <FirstRunHooksStep steps={[{ label: 'Workspace', state: 'done' }, { label: 'Orchestration', state: 'done' }, { label: 'Hooks', state: 'current' }]} rows={rows} installCount={3} disabledReason={null} onSet={() => {}} onInstallAll={() => {}} onSkip={() => {}} />
}
