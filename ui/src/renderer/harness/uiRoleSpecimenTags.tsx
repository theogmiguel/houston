import React from 'react'
import { TAG_POPOVER_CLS, tagPopoverWidthClass } from '../src/components/ui/TagPopoverChrome'
import { TagChip } from '../src/components/ui/TagChip'

const TAG = { id: 1, name: 'Review', color: '#f59e0b' }

export function UiRoleSpecimenTags(): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-2)]">
      <div className={TAG_POPOVER_CLS.prompt}>
        <h3 className={TAG_POPOVER_CLS.promptTitle}>Tags are turned off</h3>
        <p className={TAG_POPOVER_CLS.promptCopy}>Grid cards don't show tags.</p>
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
    </div>
  )
}
