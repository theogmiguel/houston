import { useEffect, useRef, useState } from 'react'
import { IconMoreHorizontal } from '../icons'
import { MATERIAL_CLS, materialAttrs } from '../material'
import { Button } from './Button'

export interface ActionMenuItem {
  label: string
  onSelect: () => void
  tone?: 'default' | 'danger'
}

export function ActionMenu({
  label,
  items,
  iconOnly = false
}: {
  label: string
  items: ActionMenuItem[]
  iconOnly?: boolean
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
    <div ref={root} className="relative inline-flex">
      {iconOnly
        ? <Button variant="icon" icon={IconMoreHorizontal} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
        : <Button variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{label}</Button>}
      {open && <div {...materialAttrs('raised')} role="menu" className={`absolute right-0 top-[calc(100%+var(--space-1))] z-50 grid min-w-[140px] gap-[var(--space-1)] p-[var(--space-1)] ${MATERIAL_CLS.raised}`}>
        {items.map((item) => <Button key={item.label} role="menuitem" variant={item.tone === 'danger' ? 'danger' : 'ghost'} size="sm" className="justify-start" onClick={() => { setOpen(false); item.onSelect() }}>{item.label}</Button>)}
      </div>}
    </div>
  )
}
