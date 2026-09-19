import { CONTROL_SIZE_SQUARE_CLS } from '../components/controlSize'
import { IconMic } from '../components/icons'
import { Tooltip } from '../components/Tooltip'
import { dictationShortcut } from '../keymap'
import { useVoiceActivity } from './store'
import { Icon } from '../components/Icon'

export function VoiceMicChip({
  paneTitle
}: {
  paneTitle: (session: number) => string | null
}): React.JSX.Element | null {
  const activity = useVoiceActivity()
  if (!activity) return null

  const listening = activity.kind === 'listening'
  const title = paneTitle(activity.session)
  const where = title ? `in ${title}` : `in pane ${activity.session}`
  const label = listening
    ? `Listening ${where} — release ${dictationShortcut.keyLabel} to transcribe`
    : `Transcribing ${where}…`

  return (
    <Tooltip label={label}>
      <span
        data-testid="voice-mic-chip"
        data-voice-state={activity.kind}
        aria-label={label}
        role="status"
        aria-live="polite"
        className={`inline-flex ${CONTROL_SIZE_SQUARE_CLS.mini} flex-none items-center justify-center rounded-full ${
          listening
            ?
              'loop-anim text-[var(--danger)] [--dot-pulse-opacity:0.4] [animation:dot-pulse_1.1s_ease-in-out_infinite] motion-reduce:[animation:none]'
            : 'text-[var(--text-muted)]'
        }`}
      >
        <Icon glyph={IconMic} role="ui" />
      </span>
    </Tooltip>
  )
}
