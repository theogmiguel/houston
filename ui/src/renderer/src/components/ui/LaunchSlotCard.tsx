import type { AgentKind } from '../../houston/generated/AgentKind'
import type { ChatEffort } from '../../houston/generated/ChatEffort'
import type { SessionSlot, SlotOverrides } from '../sessionPresets'
import { Select } from '../Select'

const AGENTS: readonly AgentKind[] = ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'grok', 'shell']
const LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor Agent', antigravity: 'Antigravity',
  opencode: 'OpenCode', grok: 'Grok Build', shell: 'Terminal', custom: 'Custom', ssh: 'SSH',
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
}

const FIELD = 'flex min-w-0 flex-col gap-[var(--space-1)]'
const FIELD_LABEL = '[font-size:var(--tr-text-micro-size)] uppercase tracking-[var(--tr-text-label-tracking)] text-[var(--text-faint)]'
const SOURCE = '[font-size:var(--tr-text-micro-size)] text-[var(--text-muted)]'
const FIELD_VALUE = 'min-w-0 truncate rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-2)] py-[var(--space-1)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)]'

export function LaunchSlotCard({ slot, workspaceName, override, onAgentChange, onModelChange, onEffortChange }: LaunchSlotCardProps): React.JSX.Element {
  return (
    <div data-slot={slot.index} className="flex min-w-0 flex-col gap-[var(--space-2)] rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-2)]">
      <div className="flex min-w-0 items-center gap-[var(--space-2)]">
        <span className="flex-none [font-size:var(--tr-text-small-size)] tabular-nums text-[var(--text-faint)]">{slot.index + 1}</span>
        <span className="min-w-0 flex-1 truncate [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">
          {LABELS[slot.agent] ?? slot.agent}{slot.roleLabel && <span className="text-[var(--text-muted)]"> · {slot.roleLabel}</span>}
        </span>
        <span className={SOURCE}>{slot.agentSource}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-[var(--space-2)] gap-y-[var(--space-1-5)]">
        <div className={FIELD}>
          <span className={FIELD_LABEL}>Agent</span>
          <Select aria-label={`Agent override for slot ${slot.index + 1}`} value={slot.agent}
            options={AGENTS.map((value) => ({ value, label: LABELS[value] }))} onChange={(value) => onAgentChange(value as AgentKind)} />
          {override.agent && <span className={SOURCE}>user override</span>}
        </div>
        <div className={FIELD}>
          <span className={FIELD_LABEL}>Model</span>
          <input aria-label={`Model override for slot ${slot.index + 1}`} placeholder="Default model" value={override.model ?? slot.model ?? ''}
            onChange={(event) => onModelChange(event.target.value || null)} className={FIELD_VALUE} />
          <span data-testid={`slot-model-source-${slot.index}`} className={SOURCE}>{slot.modelSource}</span>
        </div>
        <div className={FIELD}>
          <span className={FIELD_LABEL}>Effort</span>
          <Select aria-label={`Effort override for slot ${slot.index + 1}`} value={override.effort ?? slot.effort ?? ''}
            options={[{ value: '', label: 'Default effort' }, ...EFFORTS.map((value) => ({ value, label: value }))]}
            onChange={(value) => onEffortChange(value ? value as ChatEffort : null)} />
          <span data-testid={`slot-effort-source-${slot.index}`} className={SOURCE}>{override.effort ? 'user override' : slot.effortSource}</span>
        </div>
        <div className={FIELD}>
          <span className={FIELD_LABEL}>Checkout</span>
          <span className={FIELD_VALUE}>This checkout · {workspaceName}</span>
          <span className={SOURCE}>workspace setting</span>
        </div>
      </div>
      {slot.skippedRoute && <span role="status">Skipped route: {slot.skippedRoute}</span>}
      {slot.invalidReason && <span role="alert" className="[font-size:var(--tr-text-small-size)] text-[var(--danger)]">{slot.invalidReason}</span>}
    </div>
  )
}

export function LaunchSlotCardSpecimen(): React.JSX.Element {
  return <LaunchSlotCard slot={{ index: 0, agent: 'claude', roleLabel: 'builder', prompt: '', model: null, effort: null, modelSource: 'agent default', effortSource: 'workspace setting', agentSource: 'preset', skippedRoute: null, invalidReason: null }}
    workspaceName="Houston" override={{}} onAgentChange={() => {}} onModelChange={() => {}} onEffortChange={() => {}} />
}
