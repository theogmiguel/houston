import { useEffect, useRef, useState } from 'react'
import { listEditors, openInEditor, type EditorTarget } from '../houston/bridge'
import { IconChevronRight } from './icons'
import { Icon } from './Icon'
import { POP_ORIGIN_CLS, popOriginStyle } from './overlayChrome'

export const LAST_EDITOR_KEY = 'tr-external-editor'

const CANDIDATES_COPY = 'code, code-insiders, codium, cursor, zed, windsurf'

function readLastEditor(): string | null {
  try {
    return localStorage.getItem(LAST_EDITOR_KEY)
  } catch {
    return null
  }
}

function writeLastEditor(id: string): void {
  try {
    localStorage.setItem(LAST_EDITOR_KEY, id)
  } catch {
  }
}

export function orderEditors(editors: EditorTarget[], lastUsed: string | null): EditorTarget[] {
  if (!lastUsed) return editors
  const idx = editors.findIndex((e) => e.id === lastUsed)
  if (idx <= 0) return editors
  return [editors[idx], ...editors.slice(0, idx), ...editors.slice(idx + 1)]
}

export interface OpenInMenuProps {
  path: string
  line?: number
  col?: number
  label?: string
  icon?: React.ReactNode
  itemClass: string
  onDone: () => void
  onError: (message: string) => void
}

export function OpenInMenu({
  path,
  line,
  col,
  label = 'Open in',
  icon,
  itemClass,
  onDone,
  onError
}: OpenInMenuProps): React.JSX.Element {
  const [editors, setEditors] = useState<EditorTarget[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void listEditors().then((list) => {
      if (!cancelled) setEditors(orderEditors(list, readLastEditor()))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const launch = (id: string): void => {
    writeLastEditor(id)
    onDone()
    void openInEditor(id, path, line, col).catch((e: unknown) =>
      onError(String((e as Error)?.message ?? e))
    )
  }

  const rowRef = useRef<HTMLButtonElement>(null)
  const rect = open ? (rowRef.current?.getBoundingClientRect() ?? null) : null

  return (
    <div
      className="relative"
      data-testid="open-in-menu"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={rowRef}
        className={`btn border-none ${itemClass}`}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        <span className="flex-1 text-left">{label}</span>
        <Icon glyph={IconChevronRight} role="small" className="text-[var(--text-faint)] flex-none" />
      </button>
      {open && (
        <div
          role="menu"
          data-testid="open-in-submenu"
          className={`fixed min-w-[170px] flex flex-col p-1 rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--raised)] shadow-[var(--shadow-1)] z-[var(--z-context)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] ${POP_ORIGIN_CLS}`}
          style={
            rect
              ? {
                  top: Math.max(8, Math.min(rect.top, window.innerHeight - 180)),
                  left: rect.left > 190 ? rect.left - 178 : rect.right + 4,
                  ...popOriginStyle(rect.left > 190 ? 'right' : 'left', 'top')
                }
              : undefined
          }
        >
          {editors && editors.length === 0 ? (
            <button className={`btn border-none ${itemClass}`} role="menuitem" disabled>
              No editor found on PATH — {CANDIDATES_COPY}
            </button>
          ) : (
            (editors ?? []).map((e) => (
              <button
                key={e.id}
                className={`btn border-none ${itemClass}`}
                role="menuitem"
                onClick={() => launch(e.id)}
              >
                {e.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
