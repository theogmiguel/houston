import type { ReactNode } from 'react'
import { Button } from './Button'

export function TaskDescriptionPreview({
  children,
  expanded,
  canExpand,
  onToggle,
  onDoubleClick
}: {
  children: ReactNode
  expanded: boolean
  canExpand: boolean
  onToggle: () => void
  onDoubleClick: () => void
}): React.JSX.Element {
  const clamped = canExpand && !expanded
  return (
    <>
      <div className="relative grid transition-[grid-template-rows] duration-150 ease-out" style={{ gridTemplateRows: clamped ? '12.4em' : '1fr' }}>
        <div className={`min-h-0 overflow-hidden p-[var(--space-3)] ${clamped ? 'line-clamp-[8]' : ''}`} onDoubleClick={onDoubleClick}>
          {children}
        </div>
        {clamped && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--card-bg)] to-transparent" />}
      </div>
      {canExpand && <div className="px-[var(--space-2)] pb-[var(--space-2)]"><Button variant="ghost" size="sm" onClick={onToggle}>{expanded ? 'Show less' : 'Show more'}</Button></div>}
    </>
  )
}

export function TaskDescriptionPreviewSpecimen(): React.JSX.Element {
  return (
    <TaskDescriptionPreview expanded={false} canExpand onToggle={() => {}} onDoubleClick={() => {}}>
      <p>Review the task description and its acceptance details.</p>
    </TaskDescriptionPreview>
  )
}
