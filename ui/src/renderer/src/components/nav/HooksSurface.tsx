import type { AgentHookState } from '../../houston/generated/AgentHookState'
import type { AgentKind } from '../../houston/generated/AgentKind'
import { AgentStatusSection } from '../settings/AgentStatusSection'
import { NavColumn } from './navChrome'
import { MATERIAL_CLS, materialAttrs } from '../material'

export function HooksSurface(props: {
  providers: AgentHookState[] | null
  onSet: (provider: AgentKind, enabled: boolean) => void
  onRefresh: () => void
  checkedAt?: number | null
}): React.JSX.Element {
  const { providers, onSet, onRefresh, checkedAt = null } = props
  return (
    <div
      data-testid="nav-surface"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full min-h-0 overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <NavColumn wide>
        <AgentStatusSection
          providers={providers}
          onSet={onSet}
          onRefresh={onRefresh}
          checkedAt={checkedAt}
        />
      </NavColumn>
    </div>
  )
}
