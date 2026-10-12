import { useEffect, useMemo, useRef } from 'react'
import { ChangesPane } from '../src/components/ChangesPane'
import type { HoustonClient } from '../src/houston/client'
import { InspectorClient } from './inspectorStories'

export function ChangesStory({ ready = false, compact = true, maximized = false, staged = true, branchComparison = false }: { ready?: boolean; compact?: boolean; maximized?: boolean; staged?: boolean; branchComparison?: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const client = useMemo(() => {
    localStorage.setItem('tr-scm-draft:/repo', ready ? 'fix(panes): repaint in the same frame after a resize' : '')
    return new InspectorClient(false, true, undefined, !staged)
  }, [ready, staged])
  useEffect(() => {
    if (!branchComparison || !host.current) return
    const observer = new MutationObserver(() => {
      const choice = host.current?.querySelector<HTMLButtonElement>('[data-testid="changes-scope-branch"]')
      if (!choice || choice.disabled) return
      observer.disconnect()
      choice.click()
    })
    observer.observe(host.current, { subtree: true, childList: true, attributes: true })
    return () => observer.disconnect()
  }, [branchComparison])
  return <div ref={host} className="flex h-full min-h-0" style={{ width: compact && !maximized ? 470 : '100%' }}>
    <ChangesPane client={client as unknown as HoustonClient} dir="/repo" compact={compact} maximized={maximized} checkoutPanes={[{ id: 3, path: "/repo/.houston/worktrees/pr-list" }]} onOpenPane={() => {}} checkoutLabel="inspector-polish" />
  </div>
}
