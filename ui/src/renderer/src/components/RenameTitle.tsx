import { useState } from 'react'
import { IconPencil } from './icons'
import { Tooltip } from './Tooltip'
import { Icon } from './Icon'
import { PANE_TITLE_INK_CLS } from '../windowFocus'

const PANE_TITLE_CLS =
  "pane-title font-medium tracking-[-0.01em] leading-[1.4] whitespace-nowrap overflow-hidden text-ellipsis [flex:0_1_auto] min-w-[32px] max-w-[220px] [@container_(min-width:560px)]:max-w-[300px] [@container_(min-width:760px)]:max-w-[420px] [@container_(min-width:1000px)]:max-w-[560px] [@container_(min-width:1300px)]:max-w-[720px] [@container_(max-width:460px)]:max-w-[180px] [@container_(max-width:400px)]:max-w-[140px] [@container_(max-width:280px)]:max-w-[100px] [@container_(max-width:200px)]:max-w-[80px] [@container_(max-width:200px)]:min-w-[12px]"

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
          <span
            className={`${PANE_TITLE_CLS} ${PANE_TITLE_INK_CLS} cursor-text border-0 border-b border-dotted border-transparent group-hover:border-b-[color-mix(in_srgb,var(--text-muted)_55%,transparent)] group-focus-within:border-b-[color-mix(in_srgb,var(--text-muted)_55%,transparent)] [transition:border-color_0.2s,color_0.18s]`}
            onDoubleClick={startEditing}
          >
            {title}
          </span>
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
