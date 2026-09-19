import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { IconCheck, IconChevronDown } from './icons'
import { OVERLAY_RAISED_CLS, OVERLAY_RAISED_ATTRS } from './overlayChrome'
import { SELECT_CLS } from './selectChrome'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

const TRIGGER_LAYOUT_CLS =
  'inline-flex items-center justify-between gap-[var(--space-2)] ' +
  'cursor-pointer text-left data-[open]:border-[var(--border-hover)]'

export interface SelectOption {
  value: string
  label: string
  title?: string
  disabled?: boolean
}

export interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
  'aria-label'?: string
  'data-testid'?: string
  className?: string
  chrome?: string
}

// How long a type-ahead buffer survives between keystrokes. 800 ms sits between
// WebKit's 1 s and GTK's 500 ms; too short splits "ne|rd", too long glues jumps.
const TYPEAHEAD_RESET_MS = 800

const MENU_MAX_H = 320

const MENU_GAP = 4
const VIEWPORT_MARGIN = 8

interface MenuPos {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

export function Select({
  value,
  options,
  onChange,
  disabled = false,
  title,
  'aria-label': ariaLabel,
  'data-testid': testId,
  className = '',
  chrome = SELECT_CLS
}: SelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const [active, setActive] = useState(0)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef<{ buf: string; at: number }>({ buf: '', at: 0 })
  const listboxId = useId()

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    setPos(null)
    if (refocus) triggerRef.current?.focus()
  }, [])

  const openMenu = useCallback(() => {
    if (disabled || options.length === 0) return
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }, [disabled, options.length, selectedIndex])

  const commit = useCallback(
    (index: number) => {
      const opt = options[index]
      if (!opt || opt.disabled) return
      if (opt.value !== value) onChange(opt.value)
      close(true)
    },
    [close, onChange, options, value]
  )

  useLayoutEffect(() => {
    if (!open) return
    const btn = triggerRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - MENU_GAP - VIEWPORT_MARGIN
    const above = r.top - MENU_GAP - VIEWPORT_MARGIN
    const flip = below < Math.min(MENU_MAX_H, 160) && above > below
    setPos({
      left: Math.max(VIEWPORT_MARGIN, Math.min(r.left, window.innerWidth - r.width - VIEWPORT_MARGIN)),
      width: r.width,
      ...(flip
        ? { bottom: window.innerHeight - r.top + MENU_GAP, maxHeight: Math.min(MENU_MAX_H, above) }
        : { top: r.bottom + MENU_GAP, maxHeight: Math.min(MENU_MAX_H, below) })
    })
  }, [open])

  useEffect(() => {
    if (!open || !pos) return
    const row = menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [open, pos, active])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (menuRef.current?.contains(t ?? null)) return
      if (triggerRef.current?.contains(t ?? null)) return
      close(false)
    }
    const onScroll = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node | null)) return
      close(false)
    }
    const onBlur = (): void => close(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [close, open])

  const step = (from: number, dir: 1 | -1): number => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
      if (!options[i].disabled) return i
    }
    return from
  }
  const edge = (dir: 1 | -1): number => {
    const start = dir === 1 ? 0 : options.length - 1
    return options[start]?.disabled ? step(start, dir) : start
  }

  const typeTo = (ch: string): void => {
    const now = Date.now()
    const t = typeahead.current
    const fresh = now - t.at > TYPEAHEAD_RESET_MS
    const buf = fresh ? ch : t.buf + ch
    typeahead.current = { buf, at: now }
    const cycling = buf.length > 1 && buf.split('').every((c) => c === buf[0])
    const needle = (cycling ? buf[0] : buf).toLowerCase()
    const base = open ? active : selectedIndex
    const from = cycling || fresh ? base + 1 : base
    for (let n = 0; n < options.length; n++) {
      const i = (from + n + options.length) % options.length
      const o = options[i]
      if (o.disabled) continue
      if (o.label.toLowerCase().startsWith(needle)) {
        if (open) setActive(i)
        else onChange(o.value)
        return
      }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return
    if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openMenu()
        return
      }
    } else {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        commit(active)
        return
      }
      if (e.key === 'Tab') {
        commit(active)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => step(i, 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => step(i, -1))
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        setActive(edge(1))
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        setActive(edge(-1))
        return
      }
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      typeTo(e.key)
    }
  }

  return (
    <>
      <Tooltip label={title} className={disabled ? 'inline-flex' : undefined}>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-label={ariaLabel}
          aria-activedescendant={open ? `${listboxId}-${active}` : undefined}
          data-testid={testId}
          data-open={open || undefined}
          disabled={disabled}
          onKeyDown={onKeyDown}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            if (open) close(true)
            else openMenu()
          }}
          className={`${chrome} ${TRIGGER_LAYOUT_CLS} ${className}`}
        >
          <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</span>
          <Icon glyph={IconChevronDown} role="small" className="flex-none text-[var(--text-muted)]" />
        </button>
      </Tooltip>
      {open && pos && (
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          data-testid={testId ? `${testId}-menu` : undefined}
          aria-label={ariaLabel}
          {...OVERLAY_RAISED_ATTRS}

          className={`${OVERLAY_RAISED_CLS} fixed z-[var(--z-dropdown)] flex flex-col p-1 overflow-y-auto overscroll-contain`}
          style={{
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            minWidth: pos.width,
            maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
            maxHeight: pos.maxHeight
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {options.map((o, i) => {
            const isSelected = o.value === value
            return (
              <Tooltip key={o.value} label={o.title}>
              <div
                id={`${listboxId}-${i}`}
                role="option"
                data-index={i}
                data-value={o.value}
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseUp={() => commit(i)}
                className={`flex items-center gap-[var(--space-2)] min-h-[var(--h-ctl)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] cursor-pointer text-[length:var(--tr-text-ui-size)] ${
                  o.disabled
                    ? 'opacity-45 cursor-not-allowed text-[var(--text-muted)]'
                    : i === active
                      ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)]'
                }`}
              >
                {}
                <span className="flex-none w-[12px]">
                  {isSelected && <Icon glyph={IconCheck} role="small" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
              </div>
              </Tooltip>
            )
          })}
        </div>
      )}
    </>
  )
}
