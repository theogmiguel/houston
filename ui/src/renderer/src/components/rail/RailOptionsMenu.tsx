import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import { IconTag, IconCheck, IconGrid, IconChevronLeft, IconChevronRight, IconArrowDown } from '../icons'
import { DisabledSettingPrompt } from '../tags/DisabledSettingPrompt'
import { useTagPopover } from '../tags/TagPopover'
import { COMPACT_DEFAULT, DETAILED_DEFAULT, setRailCardMode, type RailCardProperty, type RailPrefs } from '../../railPrefs'
import {
  RailOptionsDivider, RailOptionsSectionLabel, RailOptionsSurface, RailOptionsView, RailResetButton,
  RailMenuRow, RailMenuValue, RailMenuCheckSlot, RailCardModeSegment, RailTagDisplaySegment,
  RailTagFilterValue, RailGroupSegment,
} from '../ui/rail/RailChrome'

const CARD_PROPERTIES: { keys: RailCardProperty[]; label: string; hint?: string }[] = [
  { keys: ['tags'], label: 'Tags' },
  { keys: ['pr'], label: 'Pull request and checks' },
  { keys: ['checkout', 'diff'], label: 'Branch and changes' },
  { keys: ['inline-agents'], label: 'Agents', hint: 'up to 3' },
  { keys: ['last-message'], label: 'Last message' },
]
const SORT_LABEL = { smart: 'Agent activity', manual: 'Manual', recent: 'Recent', name: 'Name' }

function changeCardProperties(prefs: RailPrefs, keys: RailCardProperty[], checked: boolean): RailPrefs {
  return {
    ...prefs,
    properties: checked ? [...new Set([...prefs.properties, ...keys])] : prefs.properties.filter((key) => !keys.includes(key)),
    customisedProperties: true,
    tags: keys.includes('tags') && !checked ? [] : prefs.tags,
  }
}

function RailCardChecklist({ prefs, onChange, onClearTagFilter }: {
  prefs: RailPrefs; onChange: (prefs: RailPrefs) => void; onClearTagFilter?: () => void
}): React.JSX.Element {
  return <>
    <RailOptionsSectionLabel>Cards show</RailOptionsSectionLabel>
    {CARD_PROPERTIES.map(({ keys, label, hint }) => {
      const checked = keys.some((key) => prefs.properties.includes(key))
      return <RailMenuRow key={label} role="menuitemcheckbox" aria-label={label} aria-checked={checked} onClick={() => {
        if (keys.includes('tags') && checked) onClearTagFilter?.()
        onChange(changeCardProperties(prefs, keys, !checked))
      }}><RailMenuCheckSlot checked={checked} />{label}{hint && <RailMenuValue>{hint}</RailMenuValue>}</RailMenuRow>
    })}
    {prefs.customisedProperties && <RailResetButton onClick={() => onChange({ ...prefs, properties: [...(prefs.cardMode === 'detailed' ? DETAILED_DEFAULT : COMPACT_DEFAULT)], customisedProperties: false })}>Reset to defaults</RailResetButton>}
  </>
}

function RailHideChecklist({ prefs, onChange }: { prefs: RailPrefs; onChange: (prefs: RailPrefs) => void }): React.JSX.Element {
  return <>
    <RailOptionsSectionLabel>Hide</RailOptionsSectionLabel>
    {([
      ['hideIdle', 'Idle grids'], ['hideDefaultBranch', 'Grids on default branch'], ['hideEmptyGrids', 'Empty grids'],
    ] as const).map(([key, label]) => <RailMenuRow key={key} role="menuitemcheckbox" aria-checked={prefs.filters[key]} onClick={() => onChange({ ...prefs, filters: { ...prefs.filters, [key]: !prefs.filters[key] } })}>
      <RailMenuCheckSlot checked={prefs.filters[key]} />{label}
    </RailMenuRow>)}
  </>
}

function RailDisplayOptions({ prefs, onChange }: { prefs: RailPrefs; onChange: (prefs: RailPrefs) => void }): React.JSX.Element {
  return <>
    <RailOptionsSectionLabel>Layout</RailOptionsSectionLabel>
    <RailCardModeSegment value={prefs.cardMode} onChange={(mode) => onChange(setRailCardMode(prefs, mode))} />
    <RailOptionsSectionLabel>Agent activity</RailOptionsSectionLabel>
    {(['compact', 'full'] as const).map((mode) => <RailMenuRow key={mode} onClick={() => onChange({ ...prefs, agentActivity: mode })}>
      {mode === 'full' ? 'Expanded' : 'Collapsed'}<RailMenuValue>{prefs.agentActivity === mode && <Icon glyph={IconCheck} role="small" />}</RailMenuValue>
    </RailMenuRow>)}
    <RailOptionsSectionLabel>Tags display</RailOptionsSectionLabel>
    <RailTagDisplaySegment value={prefs.tagDisplay} onChange={(tagDisplay) => onChange({ ...prefs, tagDisplay, tagDisplayChosen: true })} />
  </>
}

export function RailOptionsMenu({ anchor, prefs, onChange, onClose, selectedTagIds = [], selectedTagColors = [], onClearTagFilter }: {
  anchor: HTMLElement | null; prefs: RailPrefs; onChange: (next: RailPrefs) => void; onClose: () => void
  selectedTagIds?: number[]; selectedTagColors?: string[]; onClearTagFilter?: () => void
}): React.JSX.Element | null {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [panel, setPanel] = useState<'root' | 'sort' | 'display'>('root')
  const [direction, setDirection] = useState<'none' | 'forward' | 'back'>('none')
  const [tagAnchor, setTagAnchor] = useState<HTMLElement | null>(null)
  const tagPopover = useTagPopover()
  useLayoutEffect(() => {
    if (!anchor) { setPosition(null); setPanel('root'); setDirection('none'); return }
    const rect = anchor.getBoundingClientRect()
    setPosition({ left: Math.min(rect.right + 40, window.innerWidth - 272), top: Math.min(rect.bottom - 4, Math.max(8, window.innerHeight - 500)) })
  }, [anchor])
  useEffect(() => {
    if (!anchor) return
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Element) || (!event.target.closest('[data-rail-options], [data-testid="tags-disabled-prompt"], [data-testid="tag-popover"]') && !anchor.contains(event.target))) {
        setPosition(null); onClose()
      }
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setPosition(null); onClose() } }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key) }
  }, [anchor, onClose])
  if (!anchor || !position) return null
  const navigate = (next: 'root' | 'sort' | 'display'): void => { setDirection(next === 'root' ? 'back' : 'forward'); setPanel(next) }
  return createPortal(<>
    <RailOptionsSurface style={{ ...position, maxHeight: `calc(100vh - ${position.top + 8}px)`, overflowY: 'auto' }}>
      <RailOptionsView key={panel} direction={direction}>
        {panel === 'root' ? <>
          <RailOptionsSectionLabel>Group by</RailOptionsSectionLabel>
          <RailGroupSegment value={prefs.groupBy} onChange={(groupBy) => onChange({ ...prefs, groupBy })} />
          <RailMenuRow onClick={() => navigate('sort')}><Icon glyph={IconArrowDown} role="small" tone="muted" />Sort by<RailMenuValue>{SORT_LABEL[prefs.sort]} →</RailMenuValue></RailMenuRow>
          <RailOptionsDivider />
          <RailCardChecklist prefs={prefs} onChange={onChange} onClearTagFilter={onClearTagFilter} />
          <RailOptionsDivider />
          <RailHideChecklist prefs={prefs} onChange={onChange} />
          <RailOptionsDivider />
          <RailMenuRow data-testid="rail-tags-filter" onClick={(event) => {
            if (!prefs.properties.includes('tags')) setTagAnchor(event.currentTarget)
            else tagPopover.open({ anchor: event.currentTarget, view: 'pick', selectedTagIds })
          }}><Icon glyph={IconTag} role="small" tone="muted" />Filter by tag<RailTagFilterValue active={prefs.properties.includes('tags')} colors={selectedTagColors} /></RailMenuRow>
          <RailMenuRow data-testid="rail-manage-tags" onClick={(event) => {
            tagPopover.open({ anchor: event.currentTarget, view: 'manage', selectedTagIds }); setPosition(null); onClose()
          }}><Icon glyph={IconTag} role="small" tone="muted" />Manage tags…<RailMenuValue><Icon glyph={IconChevronRight} role="small" /></RailMenuValue></RailMenuRow>
          <RailMenuRow onClick={() => navigate('display')}><Icon glyph={IconGrid} role="small" tone="muted" />Card display<RailMenuValue>{prefs.cardMode === 'compact' ? 'Condensed' : 'Detailed'} →</RailMenuValue></RailMenuRow>
        </> : <>
          <RailMenuRow onClick={() => navigate('root')}><Icon glyph={IconChevronLeft} role="small" />{panel === 'sort' ? 'Sort by' : 'Card display'}</RailMenuRow>
          <RailOptionsDivider />
          {panel === 'sort' ? (['manual', 'smart', 'recent', 'name'] as const).map((sort) => <RailMenuRow key={sort} onClick={() => { onChange({ ...prefs, sort }); navigate('root') }}>{SORT_LABEL[sort]}<RailMenuValue>{prefs.sort === sort && <Icon glyph={IconCheck} role="small" />}</RailMenuValue></RailMenuRow>) : <RailDisplayOptions prefs={prefs} onChange={onChange} />}
        </>}
      </RailOptionsView>
    </RailOptionsSurface>
    {tagAnchor && <DisabledSettingPrompt anchor={tagAnchor} onShowTags={() => {
      onChange(changeCardProperties(prefs, ['tags'], true))
      tagPopover.open({ anchor: tagAnchor, view: 'pick', selectedTagIds, onDismiss: () => setTagAnchor(null) })
    }} onClose={() => setTagAnchor(null)} />}
  </>, document.body)
}
