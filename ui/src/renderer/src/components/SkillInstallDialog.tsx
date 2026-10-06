import { LazyLegacyButton } from './ui/LazyLegacyButtonRoles'
import { useRef, useState } from 'react'
import { useFocusRestore, useFocusTrap } from './dialogFocus'
import { installSkillFromUrl, previewSkillUrl, type SkillUrlConflict } from '../houston/skillInstall'
import { IconClose, IconFileDown } from './icons'
import { CodePane } from './ui/Block'
import { DialogActions, DialogBackdrop, DialogBody, DialogPanel, DialogTitle } from './ui/Dialog'
import { Icon } from './ui/Icon'
import { PanelButton, PanelColumns, PanelFieldLabel, PanelNotice, PanelTextInput } from './ui/PanelControls'
import { Text } from './ui/Text'

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
    <DialogBackdrop tone="git" onMouseDown={onClose}>
      <DialogPanel
        ref={dialogRef}
        size="git"
        surface="git"
        animated={false}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-install-title"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
          trapTab(event)
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <DialogTitle tone="ui">
          <Icon glyph={IconFileDown} role="ui" />
          <Text as="h2" id="skill-install-title" size="ui" weight="semibold" tight tone="primary" flush className="flex-1">
            Install skill from link
          </Text>
          <LazyLegacyButton variant="legacy-ghost-icon" ref={closeRef} aria-label="Close" onClick={onClose}>
            <Icon glyph={IconClose} role="label" />
          </LazyLegacyButton>
        </DialogTitle>

        <DialogBody variant="scroll">
          {step.kind === 'url' && (
            <>
              <Text as="p" size="small" weight="small" tone="secondary" leading="normal" flush>
                Paste a direct link to a Claude Agent Skill&apos;s <code>SKILL.md</code> file — a
                URL ending in <code>/SKILL.md</code>. There is no online catalog here: this fetches
                exactly the one file you link to.
              </Text>
              <div>
                <PanelFieldLabel htmlFor="skill-install-url">SKILL.md URL</PanelFieldLabel>
                <PanelTextInput
                  id="skill-install-url"
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
              {step.error && <PanelNotice variant="alert">{step.error}</PanelNotice>}
            </>
          )}

          {(step.kind === 'preview' || step.kind === 'conflict') && (
            <>
              <div className="grid gap-[var(--space-1)]">
                <Text size="small" weight="semibold" caps tone="secondary">
                  Name
                </Text>
                <Text size="ui" weight="semibold" tone="primary">
                  {step.name}
                </Text>
              </div>
              {step.kind === 'preview' && step.description && (
                <div className="grid gap-[var(--space-1)]">
                  <Text size="small" weight="semibold" caps tone="secondary">
                    Description
                  </Text>
                  <Text size="small" weight="small" tone="secondary" leading="normal">
                    {step.description}
                  </Text>
                </div>
              )}
              <Text as="div" size="small" weight="small" tone="secondary">
                {scopeLine} Provider: Claude Code.
              </Text>

              {step.kind === 'conflict' ? (
                <>
                  <PanelNotice variant="alert" tone="warn">
                    A skill named &quot;{step.name}&quot; already exists at {step.conflict.path} and
                    differs from this link&apos;s content. Nothing has been changed yet — review the
                    difference below before replacing it.
                  </PanelNotice>
                  <PanelColumns>
                    <div className="grid gap-[var(--space-1)] min-w-0">
                      <Text size="small" weight="semibold" tone="secondary">
                        Existing content
                      </Text>
                      <CodePane size="preview">{step.conflict.existingContent}</CodePane>
                    </div>
                    <div className="grid gap-[var(--space-1)] min-w-0">
                      <Text size="small" weight="semibold" tone="secondary">
                        Incoming content
                      </Text>
                      <CodePane size="preview">{step.content}</CodePane>
                    </div>
                  </PanelColumns>
                </>
              ) : (
                <div className="grid gap-[var(--space-1)]">
                  <Text size="small" weight="semibold" tone="secondary">
                    Content
                  </Text>
                  <CodePane size="preview-tall">{step.content}</CodePane>
                </div>
              )}
              {step.error && <PanelNotice variant="alert">{step.error}</PanelNotice>}
            </>
          )}
        </DialogBody>

        <DialogActions variant="footer">
          <PanelButton onClick={onClose}>Cancel</PanelButton>
          {step.kind === 'url' && (
            <PanelButton tone="primary" disabled={step.busy || !step.value.trim()} onClick={() => fetchPreview(step.value)}>
              {step.busy ? 'Fetching…' : 'Preview'}
            </PanelButton>
          )}
          {step.kind === 'preview' && (
            <PanelButton tone="primary" disabled={step.busy} onClick={() => install(false)}>
              {step.busy ? 'Installing…' : 'Install'}
            </PanelButton>
          )}
          {step.kind === 'conflict' && (
            <PanelButton tone="primary" disabled={step.busy} onClick={() => install(true)}>
              {step.busy ? 'Replacing…' : 'Replace existing'}
            </PanelButton>
          )}
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
