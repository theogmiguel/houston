import { useContext } from 'react'
import type { TagInfo } from '../houston/generated/TagInfo'
import { MAX_TAGS_PER_SESSION } from '../houston/generated/DEFAULTS'
import { TagsContext } from '../layout/tagsContext'
import { Icon } from './Icon'
import { IconCheck } from './icons'
import { TagChipRow } from './tags'
import { Tooltip } from './Tooltip'

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
  itemCls,
  onClick
}: {
  tag: TagInfo
  on: boolean
  disabledReason?: string
  itemCls: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip label={disabledReason}>
      <button
        className={`btn border-none ${itemCls}`}
        role="menuitemcheckbox"
        aria-checked={on}
        disabled={disabledReason !== undefined}
        data-testid="pane-menu-tag-item"
        data-tag={tag.id}
        onClick={onClick}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span aria-hidden className="w-[9px] h-[9px] rounded-full flex-none" style={{ background: tag.color }} />
          <span className="truncate">{tag.name}</span>
        </span>
        {on && (
          <span className="text-[var(--accent)]">
            <Icon glyph={IconCheck} role="label" />
          </span>
        )}
      </button>
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
  onChange,
  itemCls,
  sepCls
}: {
  tagIds?: number[]
  onChange: (tags: number[]) => void
  itemCls: string
  sepCls: string
}): React.JSX.Element | null {
  const registry = useContext(TagsContext)
  if (registry.length === 0) return null
  const own = tagIds ?? []
  const full = own.length >= MAX_TAGS_PER_SESSION
  return (
    <>
      <div className={sepCls} />
      <div
        role="presentation"
        className="px-2.5 pt-[3px] pb-[1px] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[0.1em] text-[var(--text-faint)]"
      >
        Pane Tags
      </div>
      {registry.map((t) => {
        const on = own.includes(t.id)
        return (
          <PaneTagRow
            key={t.id}
            tag={t}
            on={on}
            itemCls={itemCls}
            disabledReason={!on && full ? capReason(own.length, t) : undefined}
            onClick={() => onChange(on ? own.filter((id) => id !== t.id) : [...own, t.id])}
          />
        )
      })}
    </>
  )
}
