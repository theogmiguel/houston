import { useRef, useState } from 'react'
import { useFocusRestore, useFocusTrap } from './dialogFocus'
import { installSkillFromUrl, previewSkillUrl, type SkillUrlConflict } from '../houston/skillInstall'
import { BTN_GHOST } from './buttonChrome'
import { FIELD_INPUT, FIELD_LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from './nav/navChrome'
import { IconClose, IconFileDown } from './icons'
import { Icon } from './Icon'

type Step =
  | { kind: 'url'; value: string; error: string | null; busy: boolean }
  | { kind: 'preview'; url: string; name: string; description: string; content: string; error: string | null; busy: boolean }
  | { kind: 'conflict'; url: string; name: string; content: string; conflict: SkillUrlConflict; error: string | null; busy: boolean }

export function SkillInstallDialog({
  dir,
  onInstalled,
  onClose
}: {
  dir: string | null
  onInstalled: () => void
  onClose: () => void
}): React.JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'url', value: '', error: null, busy: false })
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useFocusRestore(dialogRef, closeRef)
  const trapTab = useFocusTrap(dialogRef, 'button:not([disabled]), input:not([disabled]), textarea:not([disabled])')

  const fetchPreview = (url: string): void => {
    const trimmed = url.trim()
    if (!trimmed) return
    setStep({ kind: 'url', value: url, error: null, busy: true })
    previewSkillUrl(trimmed)
      .then((preview) =>
        setStep({
          kind: 'preview',
          url: trimmed,
          name: preview.name,
          description: preview.description,
          content: preview.content,
          error: null,
          busy: false
        })
      )
      .catch((e: unknown) => setStep({ kind: 'url', value: url, error: e instanceof Error ? e.message : String(e), busy: false }))
  }

  const install = (overwrite: boolean): void => {
    if (step.kind !== 'preview' && step.kind !== 'conflict') return
    const { url, name, content } = step
    setStep({ ...step, busy: true, error: null })
    installSkillFromUrl(name, content, dir, overwrite)
      .then((result) => {
        if (result.ok) {
          onInstalled()
          onClose()
        } else if (result.conflict) {
          setStep({ kind: 'conflict', url, name, content, conflict: result.conflict, error: null, busy: false })
        } else {
          setStep((cur) => ({ ...cur, busy: false, error: result.error }) as Step)
        }
      })
      .catch((e: unknown) => setStep((cur) => ({ ...cur, busy: false, error: e instanceof Error ? e.message : String(e) }) as Step))
  }

  const scopeLine = dir ? `Installs as a project skill in ${dir}.` : 'Installs as a user skill.'

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[color-mix(in_srgb,var(--content-bg)_80%,transparent)] backdrop-blur-[4px]"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-install-title"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
          trapTab(event)
        }}
        className="w-[560px] max-w-[calc(100vw_-_2rem)] max-h-[calc(100vh_-_4rem)] rounded-[var(--tr-radius-panel)] border border-[var(--border)] bg-[var(--card-bg)] shadow-[var(--shadow-lg)] overflow-hidden flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 py-3.5 px-5 border-b border-[var(--divider)] flex-none">
          <Icon glyph={IconFileDown} role="ui" />
          <h2 id="skill-install-title" className="m-0 flex-1 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            Install skill from link
          </h2>
          <button
            type="button"
            ref={closeRef}
            aria-label="Close"
            className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`}
            onClick={onClose}
          >
            <Icon glyph={IconClose} role="label" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto py-4 px-5 flex flex-col gap-3">
          {step.kind === 'url' && (
            <>
              <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] leading-[1.5]">
                Paste a direct link to a Claude Agent Skill&apos;s <code>SKILL.md</code> file — a
                URL ending in <code>/SKILL.md</code>. There is no online catalog here: this fetches
                exactly the one file you link to.
              </p>
              <div>
                <label className={FIELD_LABEL} htmlFor="skill-install-url">
                  SKILL.md URL
                </label>
                <input
                  id="skill-install-url"
                  className={FIELD_INPUT}
                  placeholder="https://example.com/skills/deploy/SKILL.md"
                  value={step.value}
                  disabled={step.busy}
                  onChange={(e) => setStep({ kind: 'url', value: e.target.value, error: null, busy: false })}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') fetchPreview(step.value)
                  }}
                  spellCheck={false}
                  autoFocus
                />
              </div>
              {step.error && (
                <div
                  role="alert"
                  className="py-2 px-3 rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)]"
                >
                  {step.error}
                </div>
              )}
            </>
          )}

          {(step.kind === 'preview' || step.kind === 'conflict') && (
            <>
              <div className="flex flex-col gap-1">
                <span className="[font-size:var(--tr-text-small-size)] font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                  Name
                </span>
                <span className="[font-size:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">
                  {step.name}
                </span>
              </div>
              {step.kind === 'preview' && step.description && (
                <div className="flex flex-col gap-1">
                  <span className="[font-size:var(--tr-text-small-size)] font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                    Description
                  </span>
                  <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] leading-[1.5]">
                    {step.description}
                  </span>
                </div>
              )}
              <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">
                {scopeLine} Provider: Claude Code.
              </div>

              {step.kind === 'conflict' ? (
                <>
                  <div
                    role="alert"
                    className="py-2 px-3 rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--warn)_42%,transparent)] bg-[color-mix(in_srgb,var(--warn)_11%,transparent)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)]"
                  >
                    A skill named &quot;{step.name}&quot; already exists at {step.conflict.path} and
                    differs from this link&apos;s content. Nothing has been changed yet — review the
                    difference below before replacing it.
                  </div>
                  <div className="grid grid-cols-1 gap-2 @[520px]/rpanel:grid-cols-2">
                    <div className="flex flex-col gap-1 min-w-0">
                      <span className="[font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]">
                        Existing content
                      </span>
                      <pre className="m-0 max-h-[200px] overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] p-2 font-mono [font-size:var(--tr-text-small-size)] leading-[1.5] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                        {step.conflict.existingContent}
                      </pre>
                    </div>
                    <div className="flex flex-col gap-1 min-w-0">
                      <span className="[font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]">
                        Incoming content
                      </span>
                      <pre className="m-0 max-h-[200px] overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] p-2 font-mono [font-size:var(--tr-text-small-size)] leading-[1.5] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                        {step.content}
                      </pre>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-1">
                  <span className="[font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]">
                    Content
                  </span>
                  <pre className="m-0 max-h-[240px] overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] p-2 font-mono [font-size:var(--tr-text-small-size)] leading-[1.5] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                    {step.content}
                  </pre>
                </div>
              )}
              {step.error && (
                <div
                  role="alert"
                  className="py-2 px-3 rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)]"
                >
                  {step.error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="py-3 px-5 border-t border-[var(--divider)] flex items-center justify-end gap-2 flex-none">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            Cancel
          </button>
          {step.kind === 'url' && (
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={step.busy || !step.value.trim()}
              onClick={() => fetchPreview(step.value)}
            >
              {step.busy ? 'Fetching…' : 'Preview'}
            </button>
          )}
          {step.kind === 'preview' && (
            <button type="button" className={PRIMARY_BUTTON} disabled={step.busy} onClick={() => install(false)}>
              {step.busy ? 'Installing…' : 'Install'}
            </button>
          )}
          {step.kind === 'conflict' && (
            <button type="button" className={PRIMARY_BUTTON} disabled={step.busy} onClick={() => install(true)}>
              {step.busy ? 'Replacing…' : 'Replace existing'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
