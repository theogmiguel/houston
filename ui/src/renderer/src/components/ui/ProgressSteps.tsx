import { IconCheck } from '../icons'
import { Icon } from './Icon'
import { Text } from './Text'

export interface ProgressStep {
  key: string
  label: string
  state: 'done' | 'now' | 'todo'
  /** Right-aligned detail such as a percentage. */
  trailing?: string
}

/** A checklist of the stages of a long operation; the running stage is bold and ringed. */
export function ProgressSteps({ steps, 'data-testid': testId }: { steps: ProgressStep[]; 'data-testid'?: string }): React.JSX.Element {
  return (
    <ol data-testid={testId} className="m-0 grid list-none gap-[var(--space-2-5)] p-0">
      {steps.map((step) => {
        const { state } = step
        return (
          <li
            key={step.key}
            data-state={state}
            aria-current={state === 'now' ? 'step' : undefined}
            className="grid grid-cols-[var(--sz-choice-radio-column)_minmax(0,1fr)_auto] items-center gap-[var(--space-2-5)]"
          >
            <span
              aria-hidden
              className={`grid h-[var(--space-4)] w-[var(--space-4)] place-items-center rounded-full border-[length:var(--border-choice-radio)] ${
                state === 'done' ? 'border-[var(--ok)] bg-[var(--ok)] text-white' : state === 'now' ? 'border-[var(--accent)]' : 'border-[var(--border-hover)]'
              }`}
            >
              {state === 'done' && <Icon glyph={IconCheck} role="small" />}
            </span>
            <Text weight={state === 'now' ? 'semibold' : undefined} tone={state === 'now' ? 'primary' : state === 'done' ? 'secondary' : 'muted'}>{step.label}</Text>
            <Text size="small" weight={state === 'now' ? 'semibold' : undefined} tone="muted" mono tabular>{step.trailing ?? ''}</Text>
          </li>
        )
      })}
    </ol>
  )
}

/** A thin determinate bar; `percent` null renders an empty track. */
export function ProgressBar({ percent, label }: { percent: number | null; label: string }): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-[var(--space-1)] overflow-hidden rounded-[var(--tr-radius-input)] bg-[var(--divider)]"
    >
      <div className="h-full bg-[var(--accent)] motion-safe:transition-[width]" style={{ width: `${percent ?? 0}%` }} />
    </div>
  )
}

export function ProgressStepsSpecimen(): React.JSX.Element {
  return (
    <div data-testid="progress-steps-specimen" className="grid gap-[var(--space-3)]">
      <ProgressSteps
        steps={[
          { key: 'a', label: 'Download', state: 'done' },
          { key: 'b', label: 'Verify signature', state: 'now', trailing: '40%' },
          { key: 'c', label: 'Install', state: 'todo' }
        ]}
      />
      <ProgressBar percent={40} label="Specimen progress" />
    </div>
  )
}
