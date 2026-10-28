import { useEffect, useRef, useState } from 'react'
import { IconMoreHorizontal } from '../icons'
import { Button } from './Button'
import { AnimOut } from './AnimOut'

export interface ActionMenuItem {
  label: string
  onSelect: () => void
  tone?: 'default' | 'danger'
}

const MENU_CLS =
  'absolute left-0 top-[calc(100%+var(--space-1))] z-50 grid min-w-[140px] gap-[var(--space-0-5)] p-[var(--space-1)] ' +
  'rounded-[var(--tr-radius-md)] bg-[var(--raised)] shadow-[var(--shadow-float)]'

const ITEM_CLS =
  'flex w-full items-center gap-[var(--space-2-5)] h-[var(--h-row)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] ' +
  'border-0 bg-transparent text-left [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)] ' +
  'hover:bg-[var(--accent)] hover:text-[var(--on-accent)] ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--accent-ink)] focus-visible:[outline-offset:2px]'

export function ActionMenu({
  label,
  items,
  iconOnly = false,
  className = ''
}: {
  label: string
  items: ActionMenuItem[]
  iconOnly?: boolean
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={root} className={`${/(^|\s)(absolute|fixed)(\s|$)/.test(className) ? '' : 'relative'} inline-flex ${className}`}>
      {iconOnly
        ? <Button variant="icon" icon={IconMoreHorizontal} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
        : <Button variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{label}</Button>}
      <AnimOut open={open} suppress="popover">
        {open && (
          <div role="menu" className={MENU_CLS}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`${ITEM_CLS} ${item.tone === 'danger' ? '!text-[var(--stop)]' : ''}`}
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </AnimOut>
    </div>
  )
}
