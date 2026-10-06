import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../ui/Icon'
import { IconCheck, type IconComponent } from '../icons'
import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS } from '../ui/overlayChrome'
import { Tooltip } from '../ui/Tooltip'

export interface TaskMenuItem {
  id: string
  label: string
  checked?: boolean
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
}

export interface TaskMenuSection {
  heading?: string
  items: TaskMenuItem[]
}

const MENU_WIDTH = 200
const MENU_GAP = 4
const VIEWPORT_MARGIN = 8
const FLIP_MIN_HEIGHT = 160

/// An icon button with the house raised menu. Positioned `fixed` (not
/// absolute): the side panel's card clips its children, so a menu anchored
/// inside it would be cut off at the card edge.
export function TaskMenu({
  label,
  icon: Glyph,
  sections,
  testId,
  disabled = false
}: {
  label: string
  icon: IconComponent
  sections: TaskMenuSection[]
  testId?: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const close = (refocus = false): void => {
    setOpen(false)
    setPos(null)
    if (refocus) trigger.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open) return
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const height = menu.current?.offsetHeight ?? 240
    const top =
      window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN >= Math.min(height, FLIP_MIN_HEIGHT)
        ? rect.bottom + MENU_GAP
        : Math.max(VIEWPORT_MARGIN, rect.top - MENU_GAP - height)
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN)
    )
    setPos({ top, left })
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(true)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <Tooltip label={label} className="inline-flex">
        <button
          ref={trigger}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          onClick={() => (open ? close() : setOpen(true))}
          className={`tk-ibtn ${HIT_TARGET_28}`}
        >
          <Icon glyph={Glyph} role="small" />
        </button>
      </Tooltip>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          data-testid={testId ? `${testId}-menu` : undefined}
          {...OVERLAY_RAISED_ATTRS}
          className={`${OVERLAY_RAISED_CLS} tk-menu`}
          style={{ top: pos?.top, left: pos?.left, visibility: pos ? 'visible' : 'hidden' }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') close(true)
          }}
        >
          {sections.map((section, index) => (
            <div key={section.heading ?? index} className="flex flex-col">
              {section.heading && <div className="tk-menu-head">{section.heading}</div>}
              {section.items.map((item) => (
                <Tooltip key={item.id} label={item.disabled ? item.disabledReason : undefined} className="flex">
                  <button
                    type="button"
                    role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                    aria-checked={item.checked}
                    disabled={item.disabled}
                    data-testid={item.id}
                    onClick={() => {
                      close(true)
                      item.onSelect()
                    }}
                    className="tk-menu-item w-full"
                  >
                    <span className="check">
                      {item.checked === true && <Icon glyph={IconCheck} role="small" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
