import { IconCheck, IconClose, IconMic } from '../components/icons'
import { insertVoiceText, setVoiceIndicator, showVoiceNotice, useVoiceIndicator } from './store'
import { Icon } from '../components/Icon'

export function DictationIndicator({ session }: { session: number }): React.JSX.Element | null {
  const indicator = useVoiceIndicator(session)
  if (indicator?.kind !== 'pending') return null

  return (
    <div
      data-testid="voice-indicator"
      data-voice-state={indicator.kind}
      className="pointer-events-none absolute inset-x-2 bottom-2 z-[var(--z-sticky)] flex items-center gap-2 rounded-md border border-[var(--border-hover)] bg-[var(--card-bg)] px-2 py-[6px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.4] text-[var(--text-primary)] shadow-sm"
    >
      <span className="flex-none" aria-hidden>
        <Icon glyph={IconMic} role="label" />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono" data-testid="voice-pending">
        {indicator.text}
      </span>
      <button
        type="button"
        aria-label="Insert dictated text"
        className="btn pointer-events-auto flex-none rounded border border-[var(--border-hover)] px-[6px] py-px [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] hover:border-[var(--accent)]"
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
      </button>
      <button
        type="button"
        aria-label="Discard dictated text"
        className="btn pointer-events-auto flex-none rounded border border-[var(--border-hover)] px-[6px] py-px [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] hover:border-[var(--danger)]"
        onClick={() => setVoiceIndicator(session, null)}
      >
        <Icon glyph={IconClose} role="label" />
      </button>
    </div>
  )
}
