import { useContext } from 'react'
import type { TagInfo } from '../houston/generated/TagInfo'
import { MAX_TAGS_PER_SESSION } from '../houston/generated/DEFAULTS'
import { TagsContext } from '../layout/tagsContext'
import { Icon } from './ui/Icon'
import { IconCheck } from './icons'
import { TagChipRow } from './tags'
import { PaneContextMenuCheck, PaneContextMenuGroupLabel, PaneContextMenuRow, PaneContextMenuRowLabel, PaneContextMenuSeparator } from './ui/PaneContextMenu'
import { TagSwatchDot } from './ui/TagSwatch'
import { Tooltip } from './ui/Tooltip'

function resolve(registry: TagInfo[], ids: number[]): TagInfo[] {
  return ids
    .map((id) => registry.find((t) => t.id === id))
    .filter((t): t is TagInfo => t !== undefined)
}

// A pane's own tags beside its title: named chips while the header has room,
// dots once the pane is narrow.
export function PaneHeaderTags({ tagIds }: { tagIds?: number[] }): React.JSX.Element | null {
  const tags = resolve(useContext(TagsContext), tagIds ?? [])
  if (tags.length === 0) return null
  return (
    <>
      <span className="inline-flex flex-none [@container_(max-width:360px)]:hidden">
        <TagChipRow tags={tags} />
      </span>
      <span className="hidden flex-none [@container_(max-width:360px)]:inline-flex">
        <TagChipRow tags={tags} compact />
      </span>
    </>
  )
}

function PaneTagRow({
  tag,
  on,
  disabledReason,
  onClick
}: {
  tag: TagInfo
  on: boolean
  disabledReason?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip label={disabledReason}>
      <PaneContextMenuRow
        role="menuitemcheckbox"
        aria-checked={on}
        disabled={disabledReason !== undefined}
        data-testid="pane-menu-tag-item"
        data-tag={tag.id}
        onClick={onClick}
      >
        <PaneContextMenuRowLabel className="min-w-0">
          <TagSwatchDot color={tag.color} size="menu" />
          <span className="truncate">{tag.name}</span>
        </PaneContextMenuRowLabel>
        {on && (
          <PaneContextMenuCheck>
            <Icon glyph={IconCheck} role="label" />
          </PaneContextMenuCheck>
        )}
      </PaneContextMenuRow>
    </Tooltip>
  )
}

function capReason(count: number, tag: TagInfo): string {
  return `This pane carries ${count} tags, the MAX_TAGS_PER_SESSION cap of ${MAX_TAGS_PER_SESSION} — remove one to add ${tag.name}`
}

// The pane menu's tag rows. A row toggles its tag on this pane only; the menu
// stays open so several tags can be set in one visit.
export function PaneTagMenu({
  tagIds,
  onChange
}: {
  tagIds?: number[]
  onChange: (tags: number[]) => void
}): React.JSX.Element | null {
  const registry = useContext(TagsContext)
  if (registry.length === 0) return null
  const own = tagIds ?? []
  const full = own.length >= MAX_TAGS_PER_SESSION
  return (
    <>
      <PaneContextMenuSeparator />
      <PaneContextMenuGroupLabel>Pane Tags</PaneContextMenuGroupLabel>
      {registry.map((t) => {
        const on = own.includes(t.id)
        return (
          <PaneTagRow
            key={t.id}
            tag={t}
            on={on}
            disabledReason={!on && full ? capReason(own.length, t) : undefined}
            onClick={() => onChange(on ? own.filter((id) => id !== t.id) : [...own, t.id])}
          />
        )
      })}
    </>
  )
}
