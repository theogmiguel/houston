import type { AgentKind } from '../../houston/generated/AgentKind'
import type { ChatEffort } from '../../houston/generated/ChatEffort'
import { useState } from 'react'
import type { SessionSlot, SlotOverrides } from '../sessionPresets'
import { Select } from './Select'
import { IconAgent } from '../icons'
import { ICON_ROLE_CLS } from './Icon'
import { FieldLabel } from './Field'

const AGENTS: readonly AgentKind[] = ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'grok', 'zcode', 'shell']
const LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor Agent', antigravity: 'Antigravity',
  opencode: 'OpenCode', grok: 'Grok Build', zcode: 'ZCode', shell: 'Terminal', custom: 'Custom', ssh: 'SSH',
  droid: 'Droid', copilot: 'Copilot', aider: 'Aider'
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export interface LaunchSlotCardProps {
  slot: SessionSlot
  workspaceName: string
  override: SlotOverrides
  onAgentChange: (agent: AgentKind) => void
  onModelChange: (model: string | null) => void
  onEffortChange: (effort: ChatEffort | null) => void
  onReset: () => void
}

const FIELD = 'flex min-w-0 flex-col gap-[var(--space-1)]'
const SOURCE = '[font-size:var(--tr-text-label-size)] text-[var(--text-muted)]'
const FIELD_VALUE = 'min-w-0 truncate rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-2)] py-[var(--space-1)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)]'
const editedBorderClass = (isEdited: boolean): string => isEdited ? 'border-[color-mix(in_srgb,var(--warn)_55%,transparent)]' : ''

const MODEL_OPTIONS: Partial<Record<AgentKind, string[]>> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.5-codex', 'gpt-5.4', 'gpt-5-codex']
}

function LaunchModelSelect({ agent, value, onChange, slot, className = '' }: {
  agent: AgentKind
  value: string | null
  onChange: (model: string | null) => void
  slot: number
  className?: string
}): React.JSX.Element {
  const [customSelected, setCustomSelected] = useState(false)
  const known = MODEL_OPTIONS[agent] ?? []
  const isKnown = value === null || value === '' || known.includes(value)
  const isCustom = customSelected || !isKnown
  const options = [
    { value: '', label: 'Default model' },
    ...known.map((model) => ({ value: model, label: model })),
    { value: '__custom__', label: 'Type model ID…' }
  ]
  return (
    <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
      <Select
        aria-label={`Model override for slot ${slot + 1}`}
        className={className}
        value={isCustom ? '__custom__' : value ?? ''}
        options={options}
        onChange={(next) => {
          setCustomSelected(next === '__custom__')
          if (next !== '__custom__') onChange(next || null)
        }}
      />
      {isCustom && (
        <input
          aria-label={`Typed model ID for slot ${slot + 1}`}
          value={value ?? ''}
          placeholder="Model ID"
          onChange={(event) => onChange(event.target.value || null)}
          className={`${FIELD_VALUE} ${className}`}
        />
      )}
    </div>
  )
}

export function LaunchSlotCard({ slot, workspaceName, override, onAgentChange, onModelChange, onEffortChange, onReset }: LaunchSlotCardProps): React.JSX.Element {
  const editedAgent = override.agent !== undefined
  const editedModel = override.model !== undefined
  const editedEffort = override.effort !== undefined
  const edited = editedAgent || editedModel || editedEffort
  const headerSource = edited ? 'edited' : slot.headerSource === 'user override' ? 'edited' : slot.headerSource ?? slot.agentSource
  return (
    <div data-slot={slot.index} className="flex min-w-0 flex-col gap-[var(--space-2)] rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-2)]">
      <div className="flex min-w-0 items-center gap-[var(--space-1-5)]">
        <span className="w-3 flex-none font-mono [font-size:var(--tr-text-label-size)] text-[var(--text-faint)]">{slot.index + 1}</span>
        <IconAgent agent={slot.agent} brand className={ICON_ROLE_CLS.small} />
        <span className="min-w-0 flex-1 truncate [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">
          {slot.roleLabel ?? LABELS[slot.agent] ?? slot.agent}
        </span>
        <span className={`${SOURCE} ${edited ? 'text-[var(--warn)]' : ''}`}>{headerSource}</span>
        {edited && <button type="button" aria-label={`Reset slot ${slot.index + 1}`} onClick={onReset} className="border-0 bg-transparent p-0 [font-size:var(--tr-text-label-size)] text-[var(--text-muted)] hover:text-[var(--text-primary)]">↺ reset</button>}
      </div>
      <div className="grid grid-cols-2 gap-x-[var(--space-2)] gap-y-[var(--space-1-5)]">
        <div className={FIELD}>
          <FieldLabel size="compact">Agent</FieldLabel>
          <Select className={editedBorderClass(editedAgent)} aria-label={`Agent override for slot ${slot.index + 1}`} value={slot.agent}
            options={AGENTS.map((value) => ({ value, label: LABELS[value] }))} onChange={(value) => onAgentChange(value as AgentKind)} />
        </div>
        <div className={FIELD}>
          <FieldLabel size="compact">Model</FieldLabel>
          <LaunchModelSelect className={editedBorderClass(editedModel)} agent={slot.agent} slot={slot.index} value={override.model ?? slot.model} onChange={onModelChange} />
        </div>
        <div className={FIELD}>
          <FieldLabel size="compact">Effort</FieldLabel>
          <Select className={editedBorderClass(editedEffort)} aria-label={`Effort override for slot ${slot.index + 1}`} value={override.effort ?? slot.effort ?? ''}
            options={[{ value: '', label: 'Default effort' }, ...EFFORTS.map((value) => ({ value, label: value }))]}
            onChange={(value) => onEffortChange(value ? value as ChatEffort : null)} />
        </div>
        <div className={FIELD}>
          <FieldLabel size="compact">Checkout</FieldLabel>
          <span className={FIELD_VALUE}>This checkout · {workspaceName}</span>
        </div>
      </div>
      {slot.skippedRoute && <span role="status">Skipped route: {slot.skippedRoute}</span>}
      {slot.invalidReason && <span role="alert" className="[font-size:var(--tr-text-small-size)] text-[var(--danger)]">{slot.invalidReason}</span>}
    </div>
  )
}

export function LaunchSlotCardSpecimen(): React.JSX.Element {
  return <LaunchSlotCard slot={{ index: 0, agent: 'claude', roleLabel: 'builder', prompt: '', model: null, effort: null, modelSource: 'agent default', effortSource: 'workspace setting', agentSource: 'preset', skippedRoute: null, invalidReason: null }}
    workspaceName="Houston" override={{}} onAgentChange={() => {}} onModelChange={() => {}} onEffortChange={() => {}} onReset={() => {}} />
}
