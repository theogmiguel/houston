import { IconCheck, IconClose, IconMic } from '../components/icons'
import { insertVoiceText, setVoiceIndicator, showVoiceNotice, useVoiceIndicator } from './store'
import { Icon } from '../components/ui/Icon'
import { DictationAction, DictationSurface, DictationText } from '../components/ui/DictationIndicator'

export function DictationIndicator({ session }: { session: number }): React.JSX.Element | null {
  const indicator = useVoiceIndicator(session)
  if (indicator?.kind !== 'pending') return null

  return (
    <DictationSurface
      data-testid="voice-indicator"
      data-voice-state={indicator.kind}
    >
      <span className="flex-none" aria-hidden>
        <Icon glyph={IconMic} role="label" />
      </span>
      <DictationText data-testid="voice-pending">
        {indicator.text}
      </DictationText>
      <DictationAction
        type="button"
        aria-label="Insert dictated text"
        tone="insert"
        onClick={() => {
          if (!insertVoiceText(session, indicator.text)) {
            showVoiceNotice(
              session,
              `Pane ${session} is gone — the dictated text was dropped, not sent somewhere else.`
            )
          }
          setVoiceIndicator(session, null)
        }}
      >
        <Icon glyph={IconCheck} role="label" />
      </DictationAction>
      <DictationAction
        type="button"
        aria-label="Discard dictated text"
        tone="discard"
        onClick={() => setVoiceIndicator(session, null)}
      >
        <Icon glyph={IconClose} role="label" />
      </DictationAction>
    </DictationSurface>
  )
}
