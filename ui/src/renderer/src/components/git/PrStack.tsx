import { ReviewButton } from '../ui/ReviewButtonRoles'
import { MetadataRow, MetadataValue } from '../ui/MetadataRow'
import { StackOverview, StackSectionLabel, StackLayerList, StackLayerNotice, StackLayerRow } from '../ui/StackLayerList'
import { Text } from '../ui/Text'
import type { PrStack } from '../../houston/client'
import { Icon } from '../ui/Icon'
import { IconLoaderCircle } from '../icons'
import { DiffLoadingMark } from '../ui'
function layerState(layer: PrStack['layers'][number]): 'open' | 'draft' | 'merged' | 'closed' {
  if (layer.state === 'merged') return 'merged'
  if (layer.state === 'closed') return 'closed'
  return layer.is_draft ? 'draft' : 'open'
}

export function PrStackSection({
  number,
  busy,
  stack,
  checked,
  loading,
  message,
  onLoad,
  open: openProp,
  onOpenChange
}: {
  number: number
  busy: boolean
  stack: PrStack | null
  checked: boolean
  loading: boolean
  message: string | null
  onLoad: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const open = openProp ?? stack !== null
  return (
    <StackOverview data-testid="pr-stack">
      <MetadataRow>
        <StackSectionLabel>Stack</StackSectionLabel>
        {stack === null ? (
          <MetadataValue className="min-w-0 flex-1" data-testid="pr-stack-value">
            {checked ? 'not in a stack' : 'not checked'}
          </MetadataValue>
        ) : (
          <MetadataValue className="min-w-0 flex-1" data-testid="pr-stack-value">
            #{stack.number} · {stack.layers.length === 1 ? '1 layer' : `${stack.layers.length} layers`}
          </MetadataValue>
        )}
        <ReviewButton variant="compact-action"
          type="button"
          data-testid="pr-stack-load"
          disabled={busy || loading}
          onClick={() => {
            onOpenChange?.(true)
            onLoad()
          }}
        >
          {loading ? (
            <DiffLoadingMark>
              <Icon glyph={IconLoaderCircle} role="small" />
            </DiffLoadingMark>
          ) : checked ? (
            'Reload'
          ) : (
            'Check'
          )}
        </ReviewButton>
      </MetadataRow>
      {message !== null && <StackLayerNotice tone="danger" data-testid="pr-stack-message">{message}</StackLayerNotice>}
      {open && stack !== null && (
        <StackLayerList>
          {stack.layers.map((layer) => (
            <StackLayerRow
              key={layer.number}
              data-testid={`pr-stack-layer-${layer.number}`}
              number={layer.number}
              summary={layer.title ?? layer.head_ref}
              headRef={layer.head_ref}
              state={layerState(layer)}
              selected={layer.number === number}
            />
          ))}
        </StackLayerList>
      )}
      {open && stack === null && checked && (
        <Text size="small" tone="faint" data-testid="pr-stack-none">
          GitHub serves this pull request no stack — it is not stacked, or the host has no stacks
          preview.
        </Text>
      )}
    </StackOverview>
  )
}
