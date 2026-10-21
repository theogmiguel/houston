import { useState } from 'react'
import type { AgentKind } from '../../houston/client'
import { IconAgent, IconCheck } from '../icons'
import { AGENT_LABEL, COMPOSER_AGENTS } from '../sessionPresets'
import { engineGlyphColor } from '../SessionPane'
import { AgentOptionGrid, SelectionMark } from '../ui/AgentOptionGrid'
import { Button } from '../ui/Button'
import { Icon, ICON_ROLE_CLS } from '../ui/Icon'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { Text } from '../ui/Text'

/** The coding agents a hand-off pane can run: every spawnable provider, no shell. */
export const HAND_OFF_AGENTS: readonly AgentKind[] = COMPOSER_AGENTS.filter((agent) => agent !== 'shell')

/** The agent preselected for a hand-off: the workspace's default when it is spawnable. */
export function handOffDefault(agent: AgentKind | null | undefined): AgentKind {
  return agent && HAND_OFF_AGENTS.includes(agent) ? agent : 'claude'
}

/** Which agent the user's hand-off pane opens with, before it opens. */
export function MergeQueueHandOffPicker({ defaultAgent, busy, onOpen, onCancel }: { defaultAgent?: AgentKind | null; busy: boolean; onOpen: (agent: AgentKind) => void; onCancel: () => void }): React.JSX.Element {
  const [pick, setPick] = useState<AgentKind>(() => handOffDefault(defaultAgent))
  return <div className="grid min-w-0 gap-[var(--space-3)]" data-testid="merge-queue-hand-off-picker">
    <AgentOptionGrid label="Agent">
      {HAND_OFF_AGENTS.map((agent) => {
        const selected = pick === agent
        return <ReviewButton variant="agent-option" key={agent} type="button" data-agent={agent} data-testid={`merge-queue-hand-off-${agent}`} aria-pressed={selected} selected={selected} onClick={() => setPick(agent)}>
          <span className="flex-none" style={{ color: engineGlyphColor(agent) }}><IconAgent agent={agent} className={ICON_ROLE_CLS.ui} /></span>
          <Text size="small" weight={selected ? 'semibold' : 'medium'} tone={selected ? 'primary' : 'muted'} className="flex-1 truncate">{AGENT_LABEL[agent] ?? agent}</Text>
          {selected && <SelectionMark><Icon glyph={IconCheck} role="label" /></SelectionMark>}
        </ReviewButton>
      })}
    </AgentOptionGrid>
    <div className="flex items-center gap-[var(--space-2)]">
      <Button variant="primary" size="sm" disabled={busy} data-testid="merge-queue-hand-off-open" onClick={() => onOpen(pick)}>Open pane</Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
    </div>
  </div>
}
