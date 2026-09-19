import { useState } from 'react'
import { FOCUS_HALO } from './shadowChrome'
import { IconChevronDown } from './icons'
import { HIT_TARGET_28 } from './hitTarget'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

export interface DisclosureError {
  message: string
  failingStep?: string
  elapsedMs?: number
  onRetry: () => void
}

export interface DisclosureProps {
  summary: React.ReactNode
  count?: React.ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  loading?: boolean
  error?: DisclosureError
  disabled?: boolean
  disabledReason?: string
  emptySetLabel?: string
  maxBodyHeight?: number
  scrollBody?: boolean
  children?: React.ReactNode
  className?: string
}

function Spinner(): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-[12px] w-[12px] animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  )
}

function DisclosureBody({
  children,
  maxBodyHeight,
  scrollBody = true
}: {
  children: React.ReactNode
  maxBodyHeight: number
  scrollBody?: boolean
}): React.JSX.Element {
  return (
    <div
      data-testid="disclosure-body"
      className={scrollBody ? 'overflow-y-auto' : undefined}
      style={scrollBody ? { maxHeight: maxBodyHeight } : undefined}
    >
      {children}
    </div>
  )
}

export function Disclosure({
  summary,
  count,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  loading = false,
  error,
  disabled = false,
  disabledReason,
  emptySetLabel = 'Nothing here yet',
  maxBodyHeight = 240,
  scrollBody,
  children,
  className = ''
}: DisclosureProps): React.JSX.Element {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = openProp ?? openState

  const toggle = (): void => {
    if (disabled) return
    const next = !open
    setOpenState(next)
    onOpenChange?.(next)
  }

  const isEmptySet = open && !error && !loading && count === 0

  return (
    <div
      data-testid="disclosure"
      data-state={error ? 'error' : loading ? 'loading' : open ? 'open' : 'closed'}
      className={`rounded-[var(--tr-radius-card)] border ${
        error ? 'border-[var(--danger)] bg-[var(--status-blocked-bg)]' : 'border-[var(--border)] bg-[var(--surface)]'
      } ${className}`}
    >
      <Tooltip label={disabled ? disabledReason : undefined} className="flex w-full">
        <button
          type="button"
          aria-expanded={open}
          disabled={disabled}
          onClick={toggle}
          className={`border-0 bg-transparent w-full flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] text-left text-[length:var(--tr-text-ui-size)] font-medium hover:bg-[var(--surface-hover)] active:scale-[0.995] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent ${
            error ? 'text-[var(--status-blocked-text)]' : 'text-[var(--text-primary)]'
          }`}
        >
          <span
            aria-hidden
            className={`flex-none transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
          >
            <Icon glyph={IconChevronDown} role="small" />
          </span>
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {summary}
          </span>
          {loading && <Spinner />}
          {count !== undefined && !loading && (
            <span
              data-testid="disclosure-count"
              className="flex-none tabular-nums rounded-[var(--tr-radius-sm)] px-[var(--space-1-5)] text-[length:var(--tr-text-small-size)] bg-[var(--surface-hover)] text-[var(--text-secondary)]"
            >
              {count}
            </span>
          )}
        </button>
      </Tooltip>
      <div
        className={`grid motion-safe:transition-[grid-template-rows] motion-safe:duration-[var(--motion-menu-t)] motion-safe:ease-[var(--motion-menu-ease)] ${
          open && !disabled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden border-t border-[var(--divider)] px-[var(--space-3)] py-[var(--space-2)]">
          {error ? (
            <div className="flex flex-col gap-[var(--space-2)] text-[length:var(--tr-text-small-size)]">
              {children !== undefined && children !== null && (
                <DisclosureBody
                  maxBodyHeight={maxBodyHeight}
                  scrollBody={scrollBody}
                >
                  {children}
                </DisclosureBody>
              )}
              <div>
                {error.failingStep ? `${error.failingStep}: ` : ''}
                {error.message}
              </div>
              <div className="flex items-center gap-[var(--space-2)]">
                <button
                  type="button"
                  onClick={error.onRetry}
                  className={`bg-transparent rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current font-semibold focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${HIT_TARGET_28}`}
                >
                  Try again
                </button>
                {error.elapsedMs !== undefined && (
                  <span
                    data-testid="disclosure-elapsed"
                    className="tabular-nums text-[var(--text-muted)]"
                  >
                    {(error.elapsedMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
            </div>
          ) : loading ? (
            <div className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">Loading…</div>
          ) : isEmptySet ? (
            <div data-testid="disclosure-empty-set" className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
              {emptySetLabel}
            </div>
          ) : (
            <DisclosureBody maxBodyHeight={maxBodyHeight} scrollBody={scrollBody}>
              {children}
            </DisclosureBody>
          )}
        </div>
      </div>
    </div>
  )
}
