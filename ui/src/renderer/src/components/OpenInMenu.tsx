import { useEffect, useRef, useState } from 'react'
import { listEditors, openInEditor, type EditorTarget } from '../houston/bridge'
import { POP_ORIGIN_CLS, popOriginStyle } from './ui/overlayChrome'
import { OpenInChevron, OpenInSubmenu } from './ui/OpenInSubmenu'
import { EditorContextMenuItem } from './ui/EditorContextMenu'
import type { ExplorerMenuItem } from './ui/FileExplorer'
import { Text } from './ui/Text'

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
  itemClass?: string
  itemComponent?: typeof EditorContextMenuItem | typeof ExplorerMenuItem
  onDone: () => void
  onError: (message: string) => void
}

export function OpenInMenu({
  path,
  line,
  col,
  label = 'Open in',
  icon,
  itemClass = '',
  itemComponent,
  onDone,
  onError
}: OpenInMenuProps): React.JSX.Element {
  const Item = itemComponent ?? EditorContextMenuItem
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
      <Item
        ref={rowRef}
        role="menuitem"
        className={itemClass}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        <Text className="flex-1">{label}</Text>
        <OpenInChevron />
      </Item>
      {open && (
        <OpenInSubmenu
          role="menu"
          data-testid="open-in-submenu"
          className={POP_ORIGIN_CLS}
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
            <Item className={itemClass} role="menuitem" disabled>
              No editor found on PATH — {CANDIDATES_COPY}
            </Item>
          ) : (
            (editors ?? []).map((e) => (
              <Item
                key={e.id}
                className={itemClass}
                role="menuitem"
                onClick={() => launch(e.id)}
              >
                {e.label}
              </Item>
            ))
          )}
        </OpenInSubmenu>
      )}
    </div>
  )
}
