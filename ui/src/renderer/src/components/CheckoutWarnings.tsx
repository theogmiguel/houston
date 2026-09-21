import type { CheckoutEntry, CheckoutWarningView } from '../checkoutFacts'
import { Icon } from './Icon'
import { IconAlertTriangle, IconGitFork } from './icons'
import { Tooltip } from './Tooltip'

// A shared checkout is the dangerous pair — a branch move changes the tree the
// other pane is testing — so it carries warning ink. A shared repository is a
// quieter fact and stays in the muted tier.
const WARNING_INK =
  'border-transparent bg-[var(--status-todo-bg)] text-[var(--status-todo-text)]'
const MUTED_INK =
  'border-transparent bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-muted)]'

const CHIP_CLS =
  'inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-pill)] max-w-[280px] ' +
  'px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border flex-none ' +
  '[-webkit-app-region:no-drag] [font-size:var(--tr-text-small-size)] ' +
  '[font-weight:var(--tr-text-small-weight)]'

function paneList(entries: CheckoutEntry[]): string {
  return entries.map((e) => `${e.session.title} — ${e.session.cwd}`).join('\n')
}

/** The top bar's ownership chips: hover or focus one to list the panes it names. */
export function CheckoutWarningChips({
  warnings
}: {
  warnings: CheckoutWarningView[]
}): React.JSX.Element | null {
  if (warnings.length === 0) return null
  return (
    <>
      {warnings.map((warning) => {
        const shared = warning.kind === 'shared-checkout'
        return (
          <Tooltip key={`${warning.kind}:${warning.label}`} label={paneList(warning.entries)}>
            <button
              type="button"
              data-testid={shared ? 'shared-checkout-chip' : 'same-repository-chip'}
              className={`${CHIP_CLS} ${shared ? WARNING_INK : MUTED_INK}`}
            >
              <Icon glyph={shared ? IconAlertTriangle : IconGitFork} role="small" />
              <span className="truncate">{warning.label}</span>
            </button>
          </Tooltip>
        )
      })}
    </>
  )
}
