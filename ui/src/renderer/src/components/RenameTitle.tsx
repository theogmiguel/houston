import { useState } from 'react'
import { IconPencil, IconUndo } from './icons'
import { Tooltip } from './ui/Tooltip'
import { Icon } from './ui/Icon'
import type { TitleSource } from '../houston/generated/TitleSource'
import { PaneTitle } from './ui'
import { RenameActionButton, RenameTitleInput } from './ui/TitleEditControls'

interface Props {
  title: string
  onRename: (title: string) => void
  titleSource?: TitleSource
  onReset?: () => void
}

export function RenameTitle({ title, onRename, titleSource, onReset }: Props): React.JSX.Element {
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
        <Tooltip label={titleSource ? `${titleSource === 'user' ? 'Manual' : 'Automatic'} name (${titleSource}). Double-click to rename` : 'Double-click to rename'}>
          <PaneTitle editable onDoubleClick={startEditing}>
            {title}
          </PaneTitle>
        </Tooltip>
        {onReset && titleSource === 'user' && <Tooltip label="Reset to automatic"><RenameActionButton aria-label="Reset to automatic" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onReset() }}><Icon glyph={IconUndo} role="label" /></RenameActionButton></Tooltip>}
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
    if (next && (next !== title || (titleSource && titleSource !== 'user'))) onRename(next)
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
