import { ReviewButton } from '../ui/ReviewButtonRoles'
import { Button } from '../ui/Button'
import { AgentOptionGrid, SelectionMark } from '../ui/AgentOptionGrid'
import { Text } from '../ui/Text'
import { useState } from 'react'
import type { AgentKind } from '../../houston/client'
import { Icon, ICON_ROLE_CLS } from '../ui/Icon'
import { IconAgent, IconCheck } from '../icons'
import { AGENT_LABEL, COMPOSER_AGENTS } from '../sessionPresets'
import { engineGlyphColor } from '../SessionPane'
import { GitDialogShell } from './GitDialogShell'

const REVIEW_PROVIDERS: readonly AgentKind[] = COMPOSER_AGENTS.filter((a) => a !== 'shell')

export function ReviewProviderModal({
  onCancel,
  onStart
}: {
  onCancel: () => void
  onStart: (agent: AgentKind) => void
}): React.JSX.Element {
  const [pick, setPick] = useState<AgentKind | null>(null)

  return (
    <GitDialogShell
      heading="Review with agent"
      testid="review-provider-modal"
      onClose={onCancel}
      footer={
        <>
          <Button variant="legacy-ghost" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="legacy-primary"
            type="button"
            data-testid="review-provider-start"
            disabled={pick === null}
            onClick={() => {
              if (pick !== null) onStart(pick)
            }}
          >
            Start review
          </Button>
        </>
      }
    >
      <AgentOptionGrid label="Engine">
          {REVIEW_PROVIDERS.map((a) => {
            const selected = pick === a
            return (
              <ReviewButton variant="agent-option"
                key={a}
                type="button"
                data-agent={a}
                data-testid={`review-provider-${a}`}
                aria-pressed={selected}
                onClick={() => setPick(a)}
                selected={selected}
              >
                <span className="flex-none" style={{ color: engineGlyphColor(a) }}>
                  <IconAgent agent={a} className={ICON_ROLE_CLS.ui} />
                </span>
                <Text size="small" weight={selected ? 'semibold' : 'medium'} tone={selected ? 'primary' : 'muted'} className="flex-1 truncate">
                  {AGENT_LABEL[a] ?? a}
                </Text>
                {selected && (
                  <SelectionMark>
                    <Icon glyph={IconCheck} role="label" />
                  </SelectionMark>
                )}
              </ReviewButton>
            )
          })}
      </AgentOptionGrid>
    </GitDialogShell>
  )
}
