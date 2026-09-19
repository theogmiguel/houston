import type { PrStack } from '../../houston/client'
import { BTN_GHOST } from '../buttonChrome'
import { Icon } from '../Icon'
import { IconLoaderCircle } from '../icons'
import { SPIN_CLASS } from './DiffBody'
import { META_ROW_CLS } from './scmChrome'

const SMALL = 'text-[length:var(--tr-text-small-size)]'
const ACTION = 'inline-flex items-center gap-1.5'
const ERROR_LINE =
  'text-[length:var(--tr-text-small-size)] text-[var(--danger)] break-words [overflow-wrap:anywhere]'
const LABEL =
  'flex-none text-[length:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]'

function layerState(layer: PrStack['layers'][number]): string {
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
    <div className="flex flex-col gap-1" data-testid="pr-stack">
      <div className={META_ROW_CLS}>
        <span className={`${LABEL} w-[92px]`}>Stack</span>
        {stack === null ? (
          <span className={`min-w-0 flex-1 ${SMALL} text-[var(--text-primary)]`} data-testid="pr-stack-value">
            {checked ? 'not in a stack' : 'not checked'}
          </span>
        ) : (
          <span className={`min-w-0 flex-1 ${SMALL} text-[var(--text-primary)]`} data-testid="pr-stack-value">
            #{stack.number} · {stack.layers.length === 1 ? '1 layer' : `${stack.layers.length} layers`}
          </span>
        )}
        <button
          type="button"
          data-testid="pr-stack-load"
          disabled={busy || loading}
          onClick={() => {
            onOpenChange?.(true)
            onLoad()
          }}
          className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1.5 ${SMALL} text-[var(--text-muted)] disabled:opacity-55`}
        >
          {loading ? (
            <span className={SPIN_CLASS}>
              <Icon glyph={IconLoaderCircle} role="small" />
            </span>
          ) : checked ? (
            'Reload'
          ) : (
            'Check'
          )}
        </button>
      </div>
      {message !== null && <div className={ERROR_LINE} data-testid="pr-stack-message">{message}</div>}
      {open && stack !== null && (
        <div
          className="border border-[var(--border)] rounded-[var(--tr-radius-sm)] overflow-hidden flex flex-col bg-[var(--content-bg)]"
          data-testid="pr-stack-layers"
        >
          {stack.layers.map((layer) => (
            <div
              key={layer.number}
              data-testid={`pr-stack-layer-${layer.number}`}
              className={`flex items-center gap-2 px-2 py-1 ${SMALL} ${
                layer.number === number ? 'bg-[var(--card-hover)]' : ''
              }`}
            >
              <span className="flex-none font-mono text-[var(--text-faint)]">#{layer.number}</span>
              <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">
                {layer.title ?? layer.head_ref}
              </span>
              <span className="flex-none font-mono text-[var(--text-faint)]">{layer.head_ref}</span>
              <span
                className={
                  layer.state === 'merged'
                    ? 'flex-none text-[var(--info)]'
                    : layer.state === 'closed'
                      ? 'flex-none text-[var(--text-muted)]'
                      : layer.is_draft
                        ? 'flex-none text-[var(--warn)]'
                        : 'flex-none text-[var(--ok)]'
                }
              >
                {layerState(layer)}
              </span>
            </div>
          ))}
        </div>
      )}
      {open && stack === null && checked && (
        <span className={`${SMALL} text-[var(--text-faint)]`} data-testid="pr-stack-none">
          GitHub serves this pull request no stack — it is not stacked, or the host has no stacks
          preview.
        </span>
      )}
    </div>
  )
}
