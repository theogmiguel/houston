import { IconMic } from '../components/icons'
import { Tooltip } from '../components/ui/Tooltip'
import { dictationShortcut } from '../keymap'
import { useVoiceActivity } from './store'
import { Icon } from '../components/ui/Icon'
import { MicrophoneStatus } from '../components/ui/DictationIndicator'

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
      <MicrophoneStatus
        data-testid="voice-mic-chip"
        data-voice-state={activity.kind}
        aria-label={label}
        role="status"
        aria-live="polite"
        listening={listening}
      >
        <Icon glyph={IconMic} role="ui" />
      </MicrophoneStatus>
    </Tooltip>
  )
}
