import type { PrCheck } from '../../houston/client'
import { Icon } from '../ui/Icon'
import { PRS_CLASSES } from '../ui/PrsClasses'
import { CheckStateDot } from '../ui/PullRequestState'
import { PrTab } from '../ui/PrTab'
import { PrLink } from '../ui/PrLink'
import { IconChevronDown, IconCheck, IconClose, IconSparkles } from '../icons'

export interface CheckAgentTarget {
  session: number
  provider: string
  label: string
  checkout: string
}

export interface CheckLogState {
  lines: string[]
  available: boolean
  loading: boolean
  truncated: boolean
}

export interface ChecksListProps {
  checks: PrCheck[]
  logs: Record<string, CheckLogState>
  expanded: string | null
  picker: string | null
  sent: Record<string, string>
  openPaneSessions?: Record<string, number>
  agents: CheckAgentTarget[]
  onToggle: (check: PrCheck) => void
  onPickAgent: (check: PrCheck) => void
  onSendToAgent: (check: PrCheck, target: CheckAgentTarget) => void
  onCreateAgent?: (check: PrCheck, provider: string) => void
  onOpenUrl?: (url: string) => void
  onOpenPane?: (session: number) => void
  logRefs: React.MutableRefObject<Map<string, Set<HTMLDivElement>>>
}

export function checkKey(check: PrCheck): string {
  return check.run_id == null ? `${check.name}:${check.url ?? ''}` : String(check.run_id)
}

function checkDuration(check: PrCheck): string {
  if (check.duration_ms == null) return check.state
  const minutes = Math.floor(check.duration_ms / 60000)
  const seconds = Math.floor((check.duration_ms % 60000) / 1000)
  return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ''}`
}

function checkSummary(check: PrCheck, duration: string): string {
  if (check.state === 'failing') return `Failed · ${duration}`
  if (check.state === 'passing') return `Passed · ${duration}`
  return `${check.state} ${duration}`
}

function CheckLog({
  check,
  log,
  picker,
  sent,
  openPaneSessions,
  agents,
  onPickAgent,
  onSendToAgent,
  onOpenPane,
  onOpenUrl,
  onCreateAgent,
  logRefs
}: Omit<ChecksListProps, 'checks' | 'logs' | 'expanded' | 'picker' | 'sent'> & {
  check: PrCheck
  log: CheckLogState | undefined
  picker: boolean
  sent: string | undefined
}): React.JSX.Element {
  const key = checkKey(check)
  const sentAgent = agents.find((agent) => agent.label === sent)
  const createdSession = openPaneSessions?.[key]
  const session = createdSession ?? sentAgent?.session

  return (
    <>
      <div
        ref={(node) => {
          const refs = logRefs.current.get(key) ?? new Set<HTMLDivElement>()
          if (node) {
            refs.add(node)
            logRefs.current.set(key, refs)
          } else {
            for (const ref of refs) if (!ref.isConnected) refs.delete(ref)
            if (refs.size) logRefs.current.set(key, refs)
            else logRefs.current.delete(key)
          }
        }}
        className={PRS_CLASSES.PRS_CLASS_54}
        data-testid={`pr-check-log-${key}`}
      >
        {log?.loading ? (
          'Loading log…'
        ) : log?.available ? (
          <>
            {log.truncated && <div className={PRS_CLASSES.PRS_CLASS_26}>Showing the last 40 lines.</div>}
            {log.lines.slice(-40).join('\n')}
          </>
        ) : (
          "Logs aren't available for this check"
        )}
      </div>
      <div className={PRS_CLASSES.PRS_CLASS_55}>
        {check.url && (
          <PrLink
            href={check.url}
            onClick={() => onOpenUrl?.(check.url!)}
            className={PRS_CLASSES.PRS_CLASS_56}
          >
            Full log ↗
          </PrLink>
        )}
        <span className={PRS_CLASSES.PRS_CLASS_57} />
        {sent ? (
          <span className={PRS_CLASSES.PRS_CLASS_58}>
            <Icon glyph={IconCheck} role="small" /> Sent to {sent} ·{' '}
            {session != null && (
              <button type="button" className={PRS_CLASSES.PRS_CLASS_59} onClick={() => onOpenPane?.(session)}>
                Open pane
              </button>
            )}
          </span>
        ) : (
          <button
            type="button"
            className={PRS_CLASSES.PRS_CLASS_60}
            onClick={() => onPickAgent(check)}
          >
            <Icon glyph={IconSparkles} role="small" />
            Fix with agent
          </button>
        )}
      </div>
      {picker && (
        <div className={PRS_CLASSES.PRS_CLASS_61} data-testid={`pr-check-picker-${key}`}>
          <div className={PRS_CLASSES.PRS_CLASS_62}>
            Send failure to
          </div>
          {agents.map((agent) => (
            <button
              key={agent.session}
              type="button"
              className={PRS_CLASSES.PRS_CLASS_42}
              onClick={() => onSendToAgent(check, agent)}
            >
              <Icon glyph={IconSparkles} role="small" />
              <span className={PRS_CLASSES.PRS_CLASS_57}>
                {agent.provider} · {agent.label}
              </span>
              <span className={PRS_CLASSES.PRS_CLASS_63}>{agent.checkout}</span>
            </button>
          ))}
          {agents.length === 0 && (
            <div className={PRS_CLASSES.PRS_CLASS_64}>
              No agent panes in this grid
            </div>
          )}
          {onCreateAgent &&
            ['Claude', 'Codex', 'Antigravity', 'OpenCode', 'Cursor', 'Grok'].map((provider) => (
              <button
                key={provider}
                type="button"
                className={PRS_CLASSES.PRS_CLASS_42}
                onClick={() => onCreateAgent(check, provider)}
              >
                <span className={PRS_CLASSES.PRS_CLASS_57}>New {provider} pane</span>
              </button>
            ))}
        </div>
      )}
    </>
  )
}

function CheckRow({
  check,
  log,
  expanded,
  picker,
  sent,
  openPaneSessions,
  agents,
  onToggle,
  onPickAgent,
  onSendToAgent,
  onOpenPane,
  onOpenUrl,
  onCreateAgent,
  logRefs,
}: Omit<ChecksListProps, 'checks' | 'logs' | 'expanded' | 'picker' | 'sent'> & {
  check: PrCheck
  log: CheckLogState | undefined
  expanded: boolean
  picker: boolean
  sent: string | undefined
}): React.JSX.Element {
  const failed = check.state === 'failing'
  const duration = checkDuration(check)
  return (
    <div
      className={`${PRS_CLASSES.PRS_CHECK_ROW} ${expanded ? PRS_CLASSES.PRS_CHECK_ROW_EXPANDED : ''}`}
      data-testid={`pr-check-${checkKey(check)}`}
    >
      <button
        type="button"
        className={PRS_CLASSES.PRS_CLASS_65}
        aria-expanded={expanded}
        disabled={!failed}
        onClick={() => onToggle(check)}
      >
        {check.state === 'passing' || check.state === 'failing'
          ? <PrTab as="span" surface="pr-check-state-icon" state={check.state} aria-hidden="true"><Icon glyph={check.state === 'passing' ? IconCheck : IconClose} role="small" /></PrTab>
          : <CheckStateDot state={check.state} size="check" />}
        <span className={PRS_CLASSES.PRS_CLASS_66}>{check.name}</span>
        <span className={PRS_CLASSES.PRS_CLASS_67}>
          {checkSummary(check, duration)}
        </span>
        {failed && (
          <Icon
            glyph={IconChevronDown}
            role="small"
            className={`${PRS_CLASSES.PRS_CHECK_CHEVRON} ${expanded ? '' : PRS_CLASSES.PRS_ROTATE_CLOSED}`}
          />
        )}
      </button>
      {failed && (
        <div
          className={PRS_CLASSES.PRS_CLASS_68}
          style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
        >
          <div className={PRS_CLASSES.PRS_CLASS_69}>
            {expanded && <CheckLog {...{ check, log, picker, sent, openPaneSessions, agents, onToggle, onPickAgent, onSendToAgent, onOpenPane, onOpenUrl, onCreateAgent, logRefs }} />}
          </div>
        </div>
      )}
    </div>
  )
}

export function ChecksList(props: ChecksListProps): React.JSX.Element {
  const { checks, logs, expanded, picker, sent, ...rowProps } = props
  const sorted = [...checks].sort((a, b) => Number(b.state === 'failing') - Number(a.state === 'failing'))
  return (
    <div className={PRS_CLASSES.PRS_CLASS_22} data-testid="pr-checks-list">
      {sorted.map((check) => {
        const key = checkKey(check)
        return (
          <div key={key} data-testid="pr-check-row">
            <CheckRow
              check={check}
              log={logs[key]}
              expanded={expanded === key}
              picker={picker === key}
              sent={sent[key]}
              {...rowProps}
            />
          </div>
        )
      })}
    </div>
  )
}
