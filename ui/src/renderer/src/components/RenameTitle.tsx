import { useState } from 'react'
import { IconPencil } from './icons'
import { Tooltip } from './ui/Tooltip'
import { Icon } from './ui/Icon'
import { PaneTitle } from './ui'
import { RenameActionButton, RenameTitleInput } from './ui/TitleEditControls'

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
          <RenameActionButton
            aria-label="Rename"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={startEditing}
          >
            <Icon glyph={IconPencil} role="label" />
          </RenameActionButton>
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
    <RenameTitleInput
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
