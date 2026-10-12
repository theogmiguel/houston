import React from 'react'
import { TAG_POPOVER_CLS, tagPopoverWidthClass } from '../src/components/ui/TagPopoverChrome'
import { TagChip } from '../src/components/ui/TagChip'
import { TagCardAffordance } from '../src/components/tags/TagCardAffordance'

const TAG = { id: 1, name: 'Review', color: '#f59e0b' }
const TAGS = [TAG, { id: 2, name: 'Backend', color: '#22d3ee' }, { id: 3, name: 'UI', color: '#a78bfa' }]

export function UiRoleSpecimenTags(): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-2)]">
      <div className={TAG_POPOVER_CLS.prompt}>
        <h3 className={TAG_POPOVER_CLS.promptTitle}>Tags are turned off</h3>
        <p className={TAG_POPOVER_CLS.promptCopy}>Grid cards don't show tags.</p>
        <div className={TAG_POPOVER_CLS.promptPreview}>
          <span className={TAG_POPOVER_CLS.promptPreviewLabel}>Cards will show</span>
          <span className={TAG_POPOVER_CLS.promptSwatches}>{TAGS.map((tag) => <span key={tag.id} className={TAG_POPOVER_CLS.promptSwatch} style={{ background: tag.color }} />)}</span>
        </div>
        <div className={TAG_POPOVER_CLS.promptActions}>
          <button type="button">Not now</button>
          <button type="button">Show tags</button>
        </div>
      </div>
      <div className={`${TAG_POPOVER_CLS.dialog} ${tagPopoverWidthClass('pick')}`}>
        <div className={TAG_POPOVER_CLS.header}>Tags</div>
        <button type="button" className={TAG_POPOVER_CLS.pickRow}>
          <TagChip tag={TAG} />
          <span className={TAG_POPOVER_CLS.tagName}>{TAG.name}</span>
        </button>
      </div>
      <div className="flex w-56 items-center gap-1">
        <TagChip tag={{ id: 10, name: 'backend', color: '#4ade80' }} variant="card" onToggle={() => {}} />
        <TagChip tag={{ id: 11, name: 'release', color: '#c084fc' }} variant="card" onToggle={() => {}} />
      </div>
      <div className="w-40">
        <TagCardAffordance tags={[{ ...TAG, name: 'A very long backend tag label' }, { ...TAGS[1], name: 'A very long release tag label' }, TAGS[2]]} mode="chips" onClick={() => {}} />
      </div>
      <div className="flex items-center gap-3">
        <TagCardAffordance tags={TAGS} mode="icon" onClick={() => {}} />
        <TagCardAffordance tags={TAGS} mode="dots" onClick={() => {}} />
        <TagCardAffordance tags={TAGS} mode="chips" onClick={() => {}} />
      </div>
    </div>
  )
}
