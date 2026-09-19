import { useEffect, useRef, useState } from 'react'
import { useFocusRestore, useFocusTrap } from '../dialogFocus'
import { BTN_GHOST, BTN_PRIMARY } from '../buttonChrome'
import { FIELD_INPUT, FIELD_LABEL } from '../nav/navChrome'
import { IconAlertTriangle, IconLoaderCircle, IconSparkles } from '../icons'
import { Icon } from '../Icon'
import { SPIN_CLASS } from './DiffBody'

export interface PrComposeModalProps {
  base: string | null
  generating: boolean
  creating: boolean
  error: string | null
  initialTitle?: string
  initialBody?: string
  onGenerate: () => void
  onCreate: (title: string, body: string) => void
  onCancel: () => void
}

// Generated text lands here first, editable, and nothing reaches `gh` until
// Create is pressed.
export function PrComposeModal({
  base,
  generating,
  creating,
  error,
  initialTitle = '',
  initialBody = '',
  onGenerate,
  onCreate,
  onCancel
}: PrComposeModalProps): React.JSX.Element {
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState(initialBody)

  useEffect(() => {
    if (generating) return
    if (initialTitle) setTitle(initialTitle)
    if (initialBody) setBody(initialBody)
  }, [initialTitle, initialBody, generating])

  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useFocusRestore(dialogRef, cancelRef)
  const trapTab = useFocusTrap(
    dialogRef,
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled])'
  )

  const canCreate = title.trim().length > 0 && !creating

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[color-mix(in_srgb,var(--content-bg)_80%,transparent)] backdrop-blur-[4px]"
      onMouseDown={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-compose-title"
        data-testid="pr-compose-modal"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !creating) onCancel()
          trapTab(event)
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[620px] max-w-[calc(100vw_-_2rem)] max-h-[calc(100vh_-_4rem)] rounded-[var(--tr-radius-panel)] border border-[var(--border)] bg-[var(--card-bg)] shadow-[var(--shadow-lg)] overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2 py-3.5 px-5 border-b border-[var(--divider)] flex-none">
          <h2
            id="pr-compose-title"
            className="m-0 flex-1 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]"
          >
            Open a pull request{base ? ` into ${base}` : ''}
          </h2>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto py-4 px-5 flex flex-col gap-3 [scrollbar-width:thin]">
          {error && (
            <div
              role="alert"
              data-testid="pr-compose-error"
              className="flex items-start gap-1.5 py-2 px-3 rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)]"
            >
              <span className="flex-none text-[var(--danger)] pt-0.5">
                <Icon glyph={IconAlertTriangle} role="small" />
              </span>
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className={FIELD_LABEL} htmlFor="pr-compose-title-input">
              Title
            </label>
            <input
              id="pr-compose-title-input"
              data-testid="pr-compose-title-input"
              className={FIELD_INPUT}
              value={title}
              spellCheck={false}
              disabled={creating}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          <div className="flex flex-col">
            <label className={FIELD_LABEL} htmlFor="pr-compose-body-input">
              Body
            </label>
            <div className="min-h-[180px] flex flex-col">
              <textarea
                id="pr-compose-body-input"
                data-testid="pr-compose-body-input"
                className={`${FIELD_INPUT} flex-1 resize-y font-mono leading-[1.5]`}
                value={body}
                spellCheck={false}
                disabled={creating}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        </div>

        <div className="flex-none flex items-center gap-2 px-5 py-3 border-t border-[var(--divider)]">
          <button
            className={`btn ${BTN_GHOST}`}
            data-testid="pr-compose-generate"
            disabled={generating || creating}
            onClick={onGenerate}
          >
            {generating ? (
              <span className={SPIN_CLASS}>
                <Icon glyph={IconLoaderCircle} role="small" />
              </span>
            ) : (
              <Icon glyph={IconSparkles} role="small" />
            )}
            {generating ? 'Writing…' : 'Write with AI'}
          </button>
          <span className="flex-1" />
          <button
            ref={cancelRef}
            className={`btn ${BTN_GHOST}`}
            data-testid="pr-compose-cancel"
            disabled={creating}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className={`btn ${BTN_PRIMARY}`}
            data-testid="pr-compose-create"
            disabled={!canCreate}
            onClick={() => onCreate(title.trim(), body)}
          >
            {creating ? 'Creating…' : 'Create pull request'}
          </button>
        </div>
      </div>
    </div>
  )
}
