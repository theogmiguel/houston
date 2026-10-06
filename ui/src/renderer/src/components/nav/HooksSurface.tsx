import type { AgentHookState } from '../../houston/generated/AgentHookState'
import { NavSurfaceFrame } from '../ui'
import type { AgentKind } from '../../houston/generated/AgentKind'
import { AgentStatusSection } from '../settings/AgentStatusSection'
import { ContentColumn } from './navChrome'

export function HooksSurface(props: {
  providers: AgentHookState[] | null
  onSet: (provider: AgentKind, enabled: boolean) => void
  onRefresh: () => void
  checkedAt?: number | null
}): React.JSX.Element {
  const { providers, onSet, onRefresh, checkedAt = null } = props
  return (
    <NavSurfaceFrame>
      <ContentColumn wide>
        <AgentStatusSection
          providers={providers}
          onSet={onSet}
          onRefresh={onRefresh}
          checkedAt={checkedAt}
        />
      </ContentColumn>
    </NavSurfaceFrame>
  )
}
