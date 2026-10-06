import { useState } from 'react'
import { IconPencil } from './icons'
import { Tooltip } from './ui/Tooltip'
import { Icon } from './ui/Icon'
import { PaneTitle } from './ui'

interface Props {
  title: string
  onRename: (title: string) => void
}

export function RenameTitle({ title, onRename }: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)

  const startEditing = (e: React.SyntheticEvent): void => {
    e.stopPropagation()
    setDraft(title)
    setEditing(true)
  }

  if (!editing) {
    return (
      <>
        <Tooltip label="Double-click to rename">
          <PaneTitle editable onDoubleClick={startEditing}>
            {title}
          </PaneTitle>
        </Tooltip>
        <Tooltip label="Rename">
          <button
            className="btn bg-transparent border-0 py-0 px-0.5 text-[color-mix(in_srgb,var(--accent)_55%,var(--text-muted))] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer inline-flex items-center flex-none [transition:opacity_0.12s_var(--animate-ease-menu,ease)] hover:text-text-primary"
            aria-label="Rename"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={startEditing}
          >
            <Icon glyph={IconPencil} role="label" />
          </button>
        </Tooltip>
      </>
    )
  }

  const commit = (): void => {
    const next = draft.trim()
    if (next && next !== title) onRename(next)
    setEditing(false)
  }

  return (
    <input
      className="[font:inherit] font-semibold bg-background border border-primary rounded-[var(--tr-radius-input)] text-text-primary px-1 py-0 min-w-0 w-[12ch]"
      autoFocus
      maxLength={40}
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}
