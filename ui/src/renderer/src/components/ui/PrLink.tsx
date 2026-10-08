import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { IconCopy, IconExternal } from '../icons'

export interface PrLinkProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  href: string
  onClick?: () => void
}

export function PrLinkSpecimen(): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 text-[length:var(--tr-text-small-size)]">
      <PrLink href="https://github.com/example/repo/pull/42" onClick={() => {}}>
        PR #42
      </PrLink>
      <span className="text-[var(--text-muted)]">Click: open in panel · Ctrl+click: open on GitHub</span>
    </div>
  )
}

export function PrLink({ href, onClick, children, className = '', ...buttonProps }: PrLinkProps): React.JSX.Element {
  const [controlHeld, setControlHeld] = useState(false)
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    const update = (event: KeyboardEvent): void => setControlHeld(event.ctrlKey)
    const clear = (): void => setControlHeld(false)
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
      window.removeEventListener('blur', clear)
    }
  }, [])

  return (
    <span className="relative inline-flex">
      <Tooltip label="Click: open in panel · Ctrl+click: open on GitHub">
        <button
          {...buttonProps}
          type="button"
          className={`inline-flex cursor-default items-center gap-[var(--space-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${controlHeld ? 'cursor-pointer' : ''} ${className}`}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (event.ctrlKey) window.open(href, '_blank', 'noopener,noreferrer')
            else onClick?.()
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setMenu((open) => !open)
          }}
        >
          {children}
        </button>
      </Tooltip>
      {menu && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 min-w-40 rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--raised)] p-[var(--space-1)] shadow-[var(--shadow-1)]"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[length:var(--tr-text-small-size)] hover:bg-[var(--hover-fill)]"
            onClick={() => {
              void navigator.clipboard.writeText(href)
              setMenu(false)
            }}
          >
            <Icon glyph={IconCopy} role="small" />
            Copy link
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[length:var(--tr-text-small-size)] hover:bg-[var(--hover-fill)]"
            onClick={() => {
              window.open(href, '_blank', 'noopener,noreferrer')
              setMenu(false)
            }}
          >
            <Icon glyph={IconExternal} role="small" />
            Open on GitHub
          </button>
        </div>
      )}
    </span>
  )
}
