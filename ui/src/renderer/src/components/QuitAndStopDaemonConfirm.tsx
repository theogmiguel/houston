import { AnimOut } from './AnimOut'
import { ConfirmModal } from './ConfirmModal'

export function QuitAndStopDaemonConfirm({
  confirm,
  onConfirm,
  onCancel
}: {
  confirm: { message: string } | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <AnimOut open={confirm !== null} suppress="modal">
      {confirm && (
        <ConfirmModal
          title="QUIT AND STOP DAEMON"
          message={confirm.message}
          confirmLabel="Quit and stop daemon"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </AnimOut>
  )
}
