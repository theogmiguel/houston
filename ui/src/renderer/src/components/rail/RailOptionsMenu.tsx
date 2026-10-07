import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import { IconTag } from '../icons'
import { Checkbox } from '../ui/Checkbox'
import { Segmented } from '../ui/SegmentedControl'
import { DisabledSettingPrompt } from '../tags/DisabledSettingPrompt'
import { useTagPopover } from '../tags/TagPopover'
import { setRailCardMode, type RailCardProperty, type RailPrefs } from '../../railPrefs'
import { Tooltip } from '../ui/Tooltip'
import {
  RailFilterButton,
  RailFilterValue,
  RailOptionsDivider,
  RailOptionsGrid,
  RailOptionsSectionLabel,
  RailOptionsStackGap,
  RailSortList,
  RailOptionsSurface,
  RailOptionsTitle,
  RailResetButton,
  RailSortCheck,
  RailSortOption,
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
}: {
  anchor: HTMLElement | null
  prefs: RailPrefs
  onChange: (next: RailPrefs) => void
  onClose: () => void
  selectedTagIds?: number[]
}): React.JSX.Element | null {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [tagAnchor, setTagAnchor] = useState<HTMLElement | null>(null)
  const tagPopover = useTagPopover()
  useEffect(() => {
    if (!anchor) {
      setPosition(null)
      return
    }
    const rect = anchor.getBoundingClientRect()
    const top = Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 460))
    setPosition({
      left: Math.min(rect.left, window.innerWidth - 272),
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
  const toggleProperty = (property: RailCardProperty, checked: boolean): void =>
    set({
      properties: checked ? [...prefs.properties, property] : prefs.properties.filter((entry) => entry !== property),
      customisedProperties: true,
    })
  return createPortal(
    <>
      <RailOptionsSurface style={{ ...position, maxHeight: `calc(100vh - ${Number(position.top) + 8}px)`, overflowY: 'auto' }}>
        <RailOptionsTitle>Sidebar options</RailOptionsTitle>
        <RailOptionsSectionLabel>Group by</RailOptionsSectionLabel>
        <Segmented
          size="xs"
          aria-label="Group by"
          className="w-full justify-between"
          options={[
            { value: 'none', label: 'None' },
            { value: 'status', label: 'Status' },
            { value: 'pr', label: 'PR' },
            { value: 'workspace', label: 'Workspace' },
          ]}
          value={prefs.groupBy}
          onChange={(groupBy: RailPrefs['groupBy']) => set({ groupBy })}
        />
        <RailOptionsDivider />
        <RailOptionsSectionLabel>Sort</RailOptionsSectionLabel>
        <RailSortList>
          {(['manual', 'smart', 'recent', 'name'] as const).map((sort) => (
            <RailSortOption
              key={sort}
              selected={prefs.sort === sort}
              onClick={() => set({ sort })}
            >
              <span className="flex-1">{sort === 'name' ? 'Name' : sort[0].toUpperCase() + sort.slice(1)}</span>
              {prefs.sort === sort && <RailSortCheck />}
            </RailSortOption>
          ))}
        </RailSortList>
        <RailOptionsDivider />
        <RailOptionsSectionLabel>Card display</RailOptionsSectionLabel>
        <Segmented
          size="xs"
          aria-label="Layout"
          className="w-full"
          options={[
            { value: 'detailed', label: 'Detailed' },
            { value: 'compact', label: 'Compact' },
          ]}
          value={prefs.cardMode}
          onChange={(cardMode: RailPrefs['cardMode']) => onChange(setRailCardMode(prefs, cardMode))}
        />
        <RailOptionsStackGap>
          <Segmented
            size="xs"
            aria-label="Agent activity"
            className="w-full"
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'full', label: 'Full list' },
            ]}
            value={prefs.agentActivity}
            onChange={(agentActivity: RailPrefs['agentActivity']) => set({ agentActivity })}
          />
        </RailOptionsStackGap>
        <RailOptionsStackGap><RailOptionsSectionLabel>Show properties</RailOptionsSectionLabel></RailOptionsStackGap>
        <RailOptionsGrid variant="always-shown">
          {(['Status', 'Unread'] as const).map((label) => (
            <Tooltip key={label} label="Always shown">
              <span>
                <Checkbox size="xs" label={label} checked disabled />
              </span>
            </Tooltip>
          ))}
        </RailOptionsGrid>
        <RailOptionsGrid>
          {PROPERTIES.map(({ key, label }) => (
            <Checkbox
              key={key}
              size="xs"
              label={label}
              checked={prefs.properties.includes(key)}
              onChange={(checked) => toggleProperty(key, checked)}
            />
          ))}
        </RailOptionsGrid>
        {prefs.customisedProperties && (
          <RailResetButton
            onClick={() =>
              set({
                properties:
                  prefs.cardMode === 'detailed'
                    ? ['status', 'unread', 'checkout', 'pr', 'diff', 'task', 'inline-agents']
                    : ['status', 'unread'],
                customisedProperties: false,
              })
            }
          >
            Reset to defaults
          </RailResetButton>
        )}
        <RailOptionsDivider />
        <RailOptionsSectionLabel>Filters</RailOptionsSectionLabel>
        <RailOptionsGrid variant="filters">
          {(
            [
              ['hideIdle', 'Hide idle grids'],
              ['hideDefaultBranch', 'Hide grids on default branch'],
              ['hideEmptyGrids', 'Hide empty grids'],
            ] as const
          ).map(([key, label]) => (
            <Checkbox
              key={key}
              size="xs"
              label={label}
              checked={prefs.filters[key]}
              onChange={(checked) =>
                set({
                  filters: { ...prefs.filters, [key]: checked },
                })
              }
            />
          ))}
          <RailFilterButton
            data-testid="rail-tags-filter"
            onClick={(event) => {
              if (!prefs.properties.includes('tags')) setTagAnchor(event.currentTarget)
              else tagPopover.open({ anchor: event.currentTarget, view: 'pick', selectedTagIds })
            }}
            active={prefs.properties.includes('tags')}
          >
            <Icon glyph={IconTag} role="small" />
            Tags
            <RailFilterValue>
              {prefs.properties.includes('tags')
                ? prefs.tags.length
                  ? `${prefs.tags.length} selected`
                  : 'All'
                : 'Off'}
            </RailFilterValue>
          </RailFilterButton>
          <RailFilterButton
            data-testid="rail-manage-tags"
            onClick={(event) => {
              tagPopover.open({ anchor: anchor ?? event.currentTarget, view: 'manage', selectedTagIds })
              setPosition(null)
              onClose()
            }}
          >
            <Icon glyph={IconTag} role="small" />
            Manage tags
          </RailFilterButton>
        </RailOptionsGrid>
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
