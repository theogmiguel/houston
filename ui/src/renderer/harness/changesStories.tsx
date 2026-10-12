import { useMemo } from 'react'
import { ChangesPane } from '../src/components/ChangesPane'
import type { HoustonClient } from '../src/houston/client'
import { InspectorClient } from './inspectorStories'

export function ChangesStory({ ready = false, compact = true, maximized = false }: { ready?: boolean; compact?: boolean; maximized?: boolean }): React.JSX.Element {
  const client = useMemo(() => {
    localStorage.setItem('tr-scm-draft:/repo', ready ? 'fix(panes): repaint in the same frame after a resize' : '')
    return new InspectorClient(false, true)
  }, [ready])
  return <div className="flex h-full min-h-0" style={{ width: compact && !maximized ? 470 : '100%' }}>
    <ChangesPane client={client as unknown as HoustonClient} dir="/repo" compact={compact} maximized={maximized} checkoutLabel="inspector-polish" />
  </div>
}
