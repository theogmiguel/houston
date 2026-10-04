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

const VALUE_CHIP = 'rounded-[var(--tr-radius-sm)] bg-[var(--raised)] px-[5px] py-[2px] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]'

export function LaunchSlotCard({ slot, workspaceName, override, onAgentChange, onModelChange, onEffortChange }: LaunchSlotCardProps): React.JSX.Element {
  return (
    <div data-slot={slot.index} className="flex min-h-[var(--h-pill)] flex-wrap items-center gap-[5px] rounded-[var(--tr-radius-sm)] bg-[var(--card-bg)] p-[8px]">
      <span className="flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tabular-nums text-[var(--text-faint)]">{slot.index + 1}</span>
      <span className="min-w-0 truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]">
        {LABELS[slot.agent] ?? slot.agent}{slot.roleLabel && <span className="text-[var(--text-muted)]"> · {slot.roleLabel}</span>}
      </span>
      <span data-testid={`slot-model-source-${slot.index}`} className={VALUE_CHIP}>{slot.model ?? 'Default model'} · {slot.modelSource}</span>
      <span data-testid={`slot-effort-source-${slot.index}`} className={VALUE_CHIP}>{slot.effort ?? 'Auto'} · {slot.effortSource}</span>
      <span className={VALUE_CHIP}>{workspaceName} · workspace setting</span>
      <Select aria-label={`Agent override for slot ${slot.index + 1}`} value={slot.agent}
        options={AGENTS.map((value) => ({ value, label: LABELS[value] }))} onChange={(value) => onAgentChange(value as AgentKind)} />
      {override.agent && <span className="[font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">user override</span>}
      <input aria-label={`Model override for slot ${slot.index + 1}`} placeholder="Model override" value={override.model ?? ''}
        onChange={(event) => onModelChange(event.target.value || null)}
        className="min-w-0 rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-2)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)]" />
      <Select aria-label={`Effort override for slot ${slot.index + 1}`} value={override.effort ?? ''}
        options={[{ value: '', label: 'Default effort' }, ...EFFORTS.map((value) => ({ value, label: value }))]}
        onChange={(value) => onEffortChange(value ? value as ChatEffort : null)} />
      {slot.skippedRoute && <span role="status">Skipped route: {slot.skippedRoute}</span>}
      {slot.invalidReason && <span role="alert">{slot.invalidReason}</span>}
    </div>
  )
}

export function LaunchSlotCardSpecimen(): React.JSX.Element {
  return <LaunchSlotCard slot={{ index: 0, agent: 'claude', roleLabel: 'builder', prompt: '', model: null, effort: null, modelSource: 'agent default', effortSource: 'workspace setting', skippedRoute: null, invalidReason: null }}
    workspaceName="Houston" override={{}} onAgentChange={() => {}} onModelChange={() => {}} onEffortChange={() => {}} />
}
