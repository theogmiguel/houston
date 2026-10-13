import { useState } from 'react'
import type { SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import { ConfirmModal } from './ConfirmModal'
import { AnimOut } from './ui/AnimOut'
import { Button } from './ui/Button'
import { PaneNotice } from './ui/PaneControls'

export function RecoveryCheckControls({ info, connected, onRecheck, onAcknowledge }: {
  info: SessionInfo
  connected: boolean
  onRecheck: () => void
  onAcknowledge: () => void
}): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false)
  if (isLive(info.state) || (info.restore_deferred == null && info.resume_notice == null)) return null
  return <>
    <PaneNotice data-testid="session-recovery-controls">
      <Button variant="ghost" size="sm" disabled={!connected} onClick={onRecheck}>Recheck recovery</Button>
      <Button variant="ghost" size="sm" disabled={!connected} onClick={() => setConfirming(true)}>Acknowledge prior processes stopped</Button>
    </PaneNotice>
    <AnimOut open={confirming} suppress="modal">
      {confirming && <ConfirmModal title="Acknowledge stopped processes" confirmLabel="I verified they stopped" message="Confirm only after you have verified that the previous unmanaged terminal and all its child processes have stopped. Houston will recheck recovery and continue to refuse any live process or unavailable process scope." onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); onAcknowledge() }} />}
    </AnimOut>
  </>
}
