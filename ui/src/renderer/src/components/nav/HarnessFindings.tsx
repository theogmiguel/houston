import { useEffect, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { HarnessFindingState } from '../../houston/generated/HarnessFindingState'
import { Chip } from '../Chip'
import { Select } from '../Select'
import { engineLabel } from '../engineLabel'
import { ListDetail } from './ListDetail'
import { FIELD_LABEL, FIELD_TEXTAREA, PRIMARY_BUTTON, SECONDARY_BUTTON, chipClass } from './navChrome'
import { FINDING_STATE_LABEL, HARNESS_ENGINES, countByState, formatDay, targetPath } from './harnessFormat'

const SECTION_HEAD_CLS = '[font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]'
const BODY_CLS =
  '[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.5] text-[var(--text-primary)]'
const MUTED_CLS =
  '[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-secondary)]'
const MONO_CLS = 'font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-secondary)] break-all'

const STATES: HarnessFindingState[] = ['open', 'dismissed', 'resolved']

/** The review's own apply prompt, or one built from its summary when it gave none. */
export function fixPrompt(f: HarnessFinding): string {
  if (f.apply_prompt.trim()) return f.apply_prompt
  const target = f.target ? ` in ${f.target}` : ''
  return `Apply this harness review recommendation${target}: ${f.recommendation || f.title}`
}

export interface HarnessFindingsProps {
  workspace: string
  findings: HarnessFinding[]
  defaultEngine: AgentKind
  onDecide: (key: string, state: HarnessFindingState) => void
  onOpenFile: (path: string) => void
  onPrepareFix: (engine: AgentKind, prompt: string) => void
}

export function HarnessFindings(props: HarnessFindingsProps): React.JSX.Element {
  const { findings } = props
  const [filter, setFilter] = useState<HarnessFindingState>('open')
  const counts = countByState(findings)
  const shown = findings.filter((f) => f.state === filter)
  const items = shown.map((f) => ({
    id: f.key,
    title: f.title,
    sub: `${f.count} ${f.count === 1 ? 'session' : 'sessions'} · ${f.confidence || 'no confidence given'}`,
    right: f.recurred ? <Chip variant="state" tone="warning" label="Raised again" /> : undefined,
    finding: f
  }))
  return (
    <div className="flex flex-col gap-[10px]">
      <div role="group" aria-label="Finding state" className="flex flex-wrap gap-[6px]">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`harness-filter-${s}`}
            aria-pressed={filter === s}
            className={chipClass(filter === s)}
            onClick={() => setFilter(s)}
          >
            {FINDING_STATE_LABEL[s]} · {counts[s]}
          </button>
        ))}
      </div>
      <ListDetail
        items={items}
        backLabel="Findings"
        listEmpty={
          <p className={`${MUTED_CLS} px-[10px] py-[8px]`}>
            {filter === 'open'
              ? 'No open findings.'
              : `No ${FINDING_STATE_LABEL[filter].toLowerCase()} findings.`}
          </p>
        }
        renderDetail={(item) =>
          item ? (
            <FindingDetail key={item.finding.key} {...props} finding={item.finding} />
          ) : (
            <p className={MUTED_CLS}>Select a finding to see its evidence and the recommended change.</p>
          )
        }
      />
    </div>
  )
}

function FindingDetail(props: HarnessFindingsProps & { finding: HarnessFinding }): React.JSX.Element {
  const { workspace, finding: f, defaultEngine, onDecide, onOpenFile, onPrepareFix } = props
  const [preparing, setPreparing] = useState(false)
  const initialPrompt = fixPrompt(f)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [engine, setEngine] = useState<AgentKind>(defaultEngine)
  useEffect(() => setPrompt(initialPrompt), [initialPrompt])

  return (
    <div data-testid="harness-finding-detail" className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-[6px]">
        <h3 className="[font-size:var(--tr-text-title-size)] font-semibold text-[var(--text-primary)]">
          {f.title}
        </h3>
        <div className="flex flex-wrap gap-[6px]">
          <Chip variant="state" label={`Observed in ${f.count} ${f.count === 1 ? 'session' : 'sessions'}`} />
          {f.confidence && <Chip variant="state" label={`Confidence: ${f.confidence}`} />}
          {f.category && <Chip variant="state" label={f.category} />}
          {f.recurred && <Chip variant="state" tone="warning" label="Raised again after a decision" />}
        </div>
      </div>

      <section className="flex flex-col gap-[6px]">
        <h4 className={SECTION_HEAD_CLS}>Evidence</h4>
        {f.quotes.length > 0 ? (
          <ul className="flex flex-col gap-[4px]">
            {f.quotes.map((q, i) => (
              <li key={i} className={`${BODY_CLS} border-l-2 border-l-[var(--border)] pl-[10px]`}>
                {q}
              </li>
            ))}
          </ul>
        ) : (
          <p className={MUTED_CLS}>The review quoted nothing for this finding.</p>
        )}
        {f.sessions.length > 0 && (
          <p className={MONO_CLS} data-testid="harness-finding-sessions">
            Sessions: {f.sessions.join(', ')}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-[6px]">
        <h4 className={SECTION_HEAD_CLS}>Recommended change</h4>
        {f.target && (
          <div className="flex items-center gap-[8px] min-w-0">
            <span className={`${MONO_CLS} min-w-0 truncate`}>{f.target}</span>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => onOpenFile(targetPath(workspace, f.target))}
            >
              Open file
            </button>
          </div>
        )}
        <p className={BODY_CLS}>{f.recommendation || 'The review gave no summary for this change.'}</p>
        {f.recommendation_kind && <p className={MUTED_CLS}>Enforced as: {f.recommendation_kind}</p>}
      </section>

      {preparing ? (
        <section data-testid="harness-prepare-fix" className="flex flex-col gap-[8px]">
          <label className={FIELD_LABEL} htmlFor={`harness-fix-${f.key}`}>
            Prompt for the fixing pane
          </label>
          <textarea
            id={`harness-fix-${f.key}`}
            className={FIELD_TEXTAREA}
            rows={7}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="flex items-center gap-[8px]">
            <Select
              aria-label="Provider for the fixing pane"
              data-testid="harness-fix-engine"
              value={engine}
              options={HARNESS_ENGINES.map((k) => ({
                value: k,
                label: engineLabel(k)
              }))}
              onChange={(v) => setEngine(v as AgentKind)}
            />
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={prompt.trim().length === 0}
              onClick={() => {
                onPrepareFix(engine, prompt.trim())
                setPreparing(false)
              }}
            >
              Open pane
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => setPreparing(false)}>
              Cancel
            </button>
          </div>
          <p className={MUTED_CLS}>
            Opening the pane does not mark this finding resolved; mark it once the change is in.
          </p>
        </section>
      ) : (
        <FindingActions finding={f} onDecide={onDecide} onPrepare={() => setPreparing(true)} />
      )}
    </div>
  )
}

function FindingActions({
  finding: f,
  onDecide,
  onPrepare
}: {
  finding: HarnessFinding
  onDecide: (key: string, state: HarnessFindingState) => void
  onPrepare: () => void
}): React.JSX.Element {
  if (f.state !== 'open') {
    return (
      <div className="flex items-center gap-[8px]">
        <span className={MUTED_CLS}>
          {FINDING_STATE_LABEL[f.state]}
          {f.decided_at_ms != null ? ` on ${formatDay(f.decided_at_ms)}` : ''}
        </span>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => onDecide(f.key, 'open')}>
          Reopen
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-[8px]">
      <button type="button" className={PRIMARY_BUTTON} onClick={onPrepare}>
        Prepare fix
      </button>
      <button type="button" className={SECONDARY_BUTTON} onClick={() => onDecide(f.key, 'resolved')}>
        Mark resolved
      </button>
      <button type="button" className={SECONDARY_BUTTON} onClick={() => onDecide(f.key, 'dismissed')}>
        Dismiss
      </button>
    </div>
  )
}
