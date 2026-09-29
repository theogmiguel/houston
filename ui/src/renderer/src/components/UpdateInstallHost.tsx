import { AnimOut } from './AnimOut'
import { UpdateInstallModal } from './UpdateInstallModal'
import { isLive } from '../houston/client'
import { dismissUpdate } from '../updateDismissal'
import { closeUpdateModal, useUpdateModalOpen } from '../updateModal'
import type { SessionInfo } from '../houston/generated/SessionInfo'
import type { UpdateState } from '../houston/generated/UpdateState'

export function liveSessionCount(sessions: Iterable<SessionInfo>): number {
  let n = 0
  for (const s of sessions) if (isLive(s.state)) n += 1
  return n
}

// Where the install modal mounts: shown while the store says so and a release is on offer.
export function UpdateInstallHost({
  update,
  sessions,
  onOpenExternal
}: {
  update: { state: UpdateState } | null
  sessions: SessionInfo[]
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const open = useUpdateModalOpen()
  const release = update?.state.kind === 'available' ? update.state.release : null
  return (
    <AnimOut open={open && release !== null} suppress="modal">
      {release && (
        <UpdateInstallModal
          release={release}
          currentVersion={__APP_VERSION__}
          sessions={sessions}
          onClose={closeUpdateModal}
          onLater={() => {
            dismissUpdate(release.version)
            closeUpdateModal()
          }}
          onOpenExternal={onOpenExternal}
        />
      )}
    </AnimOut>
  )
}
