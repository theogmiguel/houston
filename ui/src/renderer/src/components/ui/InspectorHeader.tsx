import type { HTMLAttributes, ReactNode } from 'react'
import { variants } from './variants'
import { Text } from './Text'
import './inspector.css'

export interface InspectorTab {
  id: string
  label: string
  count?: number
  countPrefix?: string
}

export function InspectorSurface({ hiddenByOverlay, ...props }: HTMLAttributes<HTMLElement> & { hiddenByOverlay?: boolean }): React.JSX.Element {
  return <aside {...props} className={`pane-inspector${hiddenByOverlay ? ' invisible' : ''}`} />
}

export function InspectorBody(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className="pane-inspector-content" />
}

export function InspectorCard(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className="inspector-card" />
}

const tab = variants('inspector-tab', {
  selected: { true: 'is-selected', false: '' }
}, { selected: 'false' })

export function InspectorHeader({
  tabs,
  active,
  onSelect,
  icon,
  title,
  checkout,
  ahead,
  branch
}: {
  tabs: InspectorTab[]
  active: string
  onSelect: (tab: string) => void
  icon: ReactNode
  title: string
  checkout: string
  ahead?: number
  branch?: string | null
}): React.JSX.Element {
  return <>
    <div className="inspector-tabs" role="tablist" aria-label="Pane inspector">
      {tabs.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={active === item.id} tabIndex={active === item.id ? 0 : -1} className={tab({ selected: active === item.id ? 'true' : 'false' })} onClick={() => onSelect(item.id)} onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const next = (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
        onSelect(tabs[next].id)
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
        {item.label}{item.count !== undefined && item.count > 0 ? <span className="inspector-tab-count">{item.countPrefix}{item.count}</span> : null}
      </button>)}
    </div>
    <div className="inspector-subject">
      <span className="inspector-subject-icon">{icon}</span>
      <Text as="strong" weight="semibold" tone="primary">{title}</Text>
      <Text as="span" size="caption" tone="muted" mono className="inspector-subject-meta">{checkout}{ahead ? ` · ↑${ahead}${branch ? ` on ${branch}` : ''}` : ''}</Text>
    </div>
  </>
}
