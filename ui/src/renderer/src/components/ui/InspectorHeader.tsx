import type { ReactNode } from 'react'
import { variants } from './variants'
import './inspector.css'

export interface InspectorTab {
  id: string
  label: string
  count?: number
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
        {item.label}{item.count ? <span className="inspector-tab-count">{item.count}</span> : null}
      </button>)}
    </div>
    <div className="inspector-subject">
      <span className="inspector-subject-icon">{icon}</span>
      <strong>{title}</strong>
      <span className="inspector-subject-meta">{checkout}{ahead ? ` · ↑${ahead}${branch ? ` on ${branch}` : ''}` : ''}</span>
    </div>
  </>
}
