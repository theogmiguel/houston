import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import { IconTag, IconCheck, IconGrid, IconChevronLeft, IconChevronRight, IconArrowDown } from '../icons'
import { Checkbox } from '../ui/Checkbox'
import { DisabledSettingPrompt } from '../tags/DisabledSettingPrompt'
import { useTagPopover } from '../tags/TagPopover'
import { setRailCardMode, type RailCardProperty, type RailPrefs } from '../../railPrefs'
import { Tooltip } from '../ui/Tooltip'
import {
  RailOptionsDivider,
  RailOptionsGrid,
  RailOptionsSectionLabel,
  RailOptionsSurface,
  RailOptionsView,
  RailOptionsTitle,
  RailResetButton,
  RailMenuRow,
  RailMenuValue,
  RailMenuCheckSlot,
  RailCardModeSegment,
  RailTagDisplaySegment,
  RailTagFilterValue,
  RailGroupSegment,
} from '../ui/rail/RailChrome'

const PROPERTIES: { key: RailCardProperty; label: string }[] = [
  { key: 'checkout', label: 'Checkout' },
  { key: 'pr', label: 'Pull request' },
  { key: 'ci', label: 'CI' },
  { key: 'diff', label: 'Diff' },
  { key: 'tags', label: 'Tags' },
  { key: 'task', label: 'Task' },
  { key: 'inline-agents', label: 'Inline agents' },
  { key: 'context', label: 'Context %' },
]

export function RailOptionsMenu({
  anchor,
  prefs,
  onChange,
  onClose,
  selectedTagIds = [],
  selectedTagColors = [],
  onClearTagFilter,
}: {
  anchor: HTMLElement | null
  prefs: RailPrefs
  onChange: (next: RailPrefs) => void
  onClose: () => void
  selectedTagIds?: number[]
  selectedTagColors?: string[]
  onClearTagFilter?: () => void
}): React.JSX.Element | null {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [panel, setPanel] = useState<'root' | 'sort' | 'display'>('root')
  const [direction, setDirection] = useState<'none' | 'forward' | 'back'>('none')
  const [tagAnchor, setTagAnchor] = useState<HTMLElement | null>(null)
  const tagPopover = useTagPopover()
  useEffect(() => {
    if (!anchor) {
      setPosition(null)
      setPanel('root')
      setDirection('none')
      return
    }
    const rect = anchor.getBoundingClientRect()
    const top = Math.min(rect.bottom - 4, Math.max(8, window.innerHeight - 280))
    setPosition({
      left: Math.min(rect.right + 40, window.innerWidth - 272),
      top,
    })
  }, [anchor])
  useEffect(() => {
    if (!anchor) return
    const close = (event: MouseEvent): void => {
      if (
        !(event.target instanceof Element) ||
        (!event.target.closest('[data-rail-options], [data-testid="tags-disabled-prompt"]') &&
          !anchor.contains(event.target))
      ) {
        setPosition(null)
        onClose()
      }
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPosition(null)
        onClose()
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', key)
    }
  }, [anchor, onClose])
  if (!anchor || !position) return null
  const set = (patch: Partial<RailPrefs>): void => onChange({ ...prefs, ...patch })
  const navigate = (next: 'root' | 'sort' | 'display'): void => {
    setDirection(next === 'root' ? 'back' : 'forward')
    setPanel(next)
  }
  const toggleProperty = (property: RailCardProperty, checked: boolean): void => {
    if (property === 'tags' && !checked) onClearTagFilter?.()
    set({
      properties: checked ? [...prefs.properties, property] : prefs.properties.filter((entry) => entry !== property),
      customisedProperties: true,
      ...(property === 'tags' && !checked ? { tags: [] } : {}),
    })
  }
  return createPortal(
    <>
      <RailOptionsSurface style={{ ...position, maxHeight: `calc(100vh - ${Number(position.top) + 8}px)`, overflowY: 'auto' }}>
        <RailOptionsView key={panel} direction={direction}>
        {panel === 'root' ? <>
          <RailOptionsTitle>Sidebar options</RailOptionsTitle>
          <RailOptionsSectionLabel>Group by</RailOptionsSectionLabel>
          <RailGroupSegment value={prefs.groupBy} onChange={(groupBy) => set({ groupBy })} />
          <RailOptionsDivider />
          <RailMenuRow onClick={() => navigate('sort')}>
            <Icon glyph={IconArrowDown} role="small" tone="muted" />Sort by
            <RailMenuValue>{prefs.sort === 'smart' ? 'Agent activity' : prefs.sort === 'manual' ? 'Manual' : prefs.sort === 'recent' ? 'Recent' : 'Name'}</RailMenuValue>
          </RailMenuRow>
          <RailMenuRow onClick={() => navigate('display')}>
            <Icon glyph={IconGrid} role="small" tone="muted" />Card display
            <RailMenuValue>{prefs.cardMode === 'compact' ? 'Condensed' : 'Detailed'}</RailMenuValue>
          </RailMenuRow>
          <RailOptionsDivider />
          <RailOptionsSectionLabel>Filters</RailOptionsSectionLabel>
          {([
            ['hideIdle', 'Hide idle grids'],
            ['hideDefaultBranch', 'Hide grids on default branch'],
            ['hideEmptyGrids', 'Hide empty grids'],
          ] as const).map(([key, label]) => <RailMenuRow key={key} selected={prefs.filters[key]} onClick={() => set({ filters: { ...prefs.filters, [key]: !prefs.filters[key] } })}>
            <RailMenuCheckSlot checked={prefs.filters[key]} />{label}
          </RailMenuRow>)}
          <RailMenuRow data-testid="rail-tags-filter" onClick={(event) => {
            if (!prefs.properties.includes('tags')) setTagAnchor(event.currentTarget)
            else tagPopover.open({ anchor: event.currentTarget, view: 'pick', selectedTagIds })
          }}>
            <Icon glyph={IconTag} role="small" tone="muted" />Tags
            <RailTagFilterValue active={prefs.properties.includes('tags')} colors={selectedTagColors} />
          </RailMenuRow>
        </> : <>
          <RailMenuRow onClick={() => navigate('root')}><Icon glyph={IconChevronLeft} role="small" />{panel === 'sort' ? 'Sort by' : 'Card display'}</RailMenuRow>
          <RailOptionsDivider />
          {panel === 'sort' ? (['manual', 'smart', 'recent', 'name'] as const).map((sort) =>
            <RailMenuRow key={sort} selected={prefs.sort === sort} onClick={() => { set({ sort }); navigate('root') }}>
              {sort === 'smart' ? 'Agent activity' : sort === 'manual' ? 'Manual' : sort === 'recent' ? 'Recent' : 'Name'}
              <RailMenuValue>{prefs.sort === sort && <Icon glyph={IconCheck} role="small" />}</RailMenuValue>
            </RailMenuRow>
          ) : <>
            <RailOptionsSectionLabel>Layout</RailOptionsSectionLabel>
            <RailCardModeSegment value={prefs.cardMode} onChange={(mode) => onChange(setRailCardMode(prefs, mode))} />
            <RailOptionsSectionLabel>Agent activity</RailOptionsSectionLabel>
            <RailMenuRow selected={prefs.agentActivity === 'compact'} onClick={() => set({ agentActivity: 'compact' })}>Collapsed<RailMenuValue>{prefs.agentActivity === 'compact' && <Icon glyph={IconCheck} role="small" />}</RailMenuValue></RailMenuRow>
            <RailMenuRow selected={prefs.agentActivity === 'full'} onClick={() => set({ agentActivity: 'full' })}>Expanded<RailMenuValue>{prefs.agentActivity === 'full' && <Icon glyph={IconCheck} role="small" />}</RailMenuValue></RailMenuRow>
            <RailOptionsDivider />
            <RailOptionsSectionLabel>Card properties</RailOptionsSectionLabel>
            <RailOptionsGrid variant="always-shown">
              {(['Status', 'Unread'] as const).map((label) => <Tooltip key={label} label="Always shown"><span><Checkbox size="xs" label={label} checked disabled /></span></Tooltip>)}
            </RailOptionsGrid>
            <RailOptionsGrid>
              {PROPERTIES.map(({ key, label }) => <Checkbox key={key} size="xs" label={label} checked={prefs.properties.includes(key)} onChange={(checked) => toggleProperty(key, checked)} />)}
            </RailOptionsGrid>
            {prefs.properties.includes('tags') && <>
              <RailOptionsSectionLabel>Tags display</RailOptionsSectionLabel>
              <RailTagDisplaySegment value={prefs.tagDisplay} onChange={(tagDisplay) => set({ tagDisplay })} />
            </>}
            {prefs.customisedProperties && <RailResetButton onClick={() => set({ properties: prefs.cardMode === 'detailed' ? ['status', 'unread', 'checkout', 'pr', 'diff', 'task', 'inline-agents'] : ['status', 'unread'], customisedProperties: false })}>Reset to defaults</RailResetButton>}
            <RailOptionsDivider />
            <RailMenuRow data-testid="rail-manage-tags" onClick={(event) => {
              tagPopover.open({ anchor: anchor ?? event.currentTarget, view: 'manage', selectedTagIds })
              setPosition(null)
              onClose()
            }}><Icon glyph={IconTag} role="small" tone="muted" />Manage tags<RailMenuValue><Icon glyph={IconChevronRight} role="small" /></RailMenuValue></RailMenuRow>
          </>}
        </>}
        </RailOptionsView>
      </RailOptionsSurface>
      {tagAnchor && (
        <DisabledSettingPrompt
          anchor={tagAnchor}
          onShowTags={() => {
            toggleProperty('tags', true)
            tagPopover.open({
              anchor: tagAnchor,
              view: 'pick',
              selectedTagIds,
              onDismiss: () => setTagAnchor(null),
            })
          }}
          onClose={() => setTagAnchor(null)}
        />
      )}
    </>,
    document.body,
  )
}
