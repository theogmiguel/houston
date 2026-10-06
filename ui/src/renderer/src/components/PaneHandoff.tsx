import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind } from '../houston/client'
import { Button, DialogBackdrop, DialogPanel } from './ui'
import { useFocusTrap } from './dialogFocus'
import { ICON_ROLE_CLS } from './ui/Icon'
import { IconAgent } from './icons'
import { AGENT_LABEL, COMPOSER_AGENTS } from './sessionPresets'
import { engineGlyphColor } from './SessionPane'
import {
  ScrollRegion,
  DialogCloseButton,
  FaintText,
  ChoiceFieldset,
  DialogFooterRow,
  DialogHeaderRow,
  DialogSectionHeading,
  SupportingText,
  FieldCaption,
  CharacterCount,
  StrongText,
  MessageTextarea,
  DialogHeadingText,
  PreviewStack,
  EmptyPreview,
  CodePreview,
  ChoiceTileGrid,
  ChoiceTile
} from './ui/ChoiceTile'
import { KeyHint } from './ui/MarkdownContent'
import {
  buildHandoffPacket,
  handoffCharCount,
  HANDOFF_ASK_DEFAULT
} from './handoffPacket'

export interface HandoffSource {
  session: number
  agent: AgentKind
  title: string
  cwd: string
  conversation: string
}

interface Props {
  source: HandoffSource
  onCancel: () => void
  onHandoff: (agent: AgentKind, packet: string) => void
}

export function handoffTargets(source: AgentKind): AgentKind[] {
  return COMPOSER_AGENTS.filter((a) => a !== 'shell' && a !== source)
}

function shortCwd(cwd: string): string {
  return cwd.replace(/^\/(home|Users)\/[^/]+/, '~')
}

export function PaneHandoff({ source, onCancel, onHandoff }: Props): React.JSX.Element {
  const [target, setTarget] = useState<AgentKind | null>(null)
  const [ask, setAsk] = useState(HANDOFF_ASK_DEFAULT)
  const dialogRef = useRef<HTMLDivElement>(null)
  const onTabKey = useFocusTrap(dialogRef, 'button:not([disabled]), textarea')

  const targets = useMemo(() => handoffTargets(source.agent), [source.agent])
  const sourceLabel = AGENT_LABEL[source.agent] ?? source.agent

  const packet = useMemo(
    () =>
      buildHandoffPacket({
        sourceLabel,
        title: source.title,
        ask,
        conversation: source.conversation
      }),
    [sourceLabel, source.title, source.conversation, ask]
  )

  useEffect(() => {
    const trigger = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
      return
    }
    onTabKey(e)
  }

  return (
    <DialogBackdrop onMouseDown={onCancel}>
      <DialogPanel
        size="paneHandoff"
        surface="raised"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pane-handoff-title"
        tabIndex={-1}
        data-testid="pane-handoff"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <DialogHeaderRow>
          <DialogHeadingText id="pane-handoff-title">
            <span className="flex-none truncate">
              <StrongText>Handoff</StrongText>
              <FaintText> from </FaintText>
              {sourceLabel}
            </span>
            <FaintText className="min-w-0 truncate">{shortCwd(source.cwd)}</FaintText>
          </DialogHeadingText>
          <DialogCloseButton onClick={onCancel} />
        </DialogHeaderRow>

        <ScrollRegion>
          <div className="grid gap-[var(--space-1)]">
            <DialogSectionHeading>Same conversation. Different teammate.</DialogSectionHeading>
            <SupportingText>The other engine gets the full thread plus your ask.</SupportingText>
          </div>

          <ChoiceFieldset legend="Handoff to">
            <ChoiceTileGrid>
              {targets.map((a) => (
                <ChoiceTile
                  key={a}
                  data-agent={a}
                  selected={target === a}
                  onClick={() => setTarget(a)}
                  checkTestId={`handoff-check-${a}`}
                  label={AGENT_LABEL[a] ?? a}
                  glyph={
                    <span className="flex-none" style={{ color: engineGlyphColor(a) }}>
                      <IconAgent agent={a} className={ICON_ROLE_CLS.ui} />
                    </span>
                  }
                />
              ))}
            </ChoiceTileGrid>
          </ChoiceFieldset>

          <div className="grid gap-[var(--space-2)]">
            <FieldCaption as="label" htmlFor="pane-handoff-ask">
              Ask
            </FieldCaption>
            {}
            <MessageTextarea
              id="pane-handoff-ask"
              data-testid="handoff-ask"
              rows={3}
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              placeholder={HANDOFF_ASK_DEFAULT}
            />
          </div>

          <PreviewStack>
            <FieldCaption>They see</FieldCaption>
            {target === null ? (
              <EmptyPreview data-testid="handoff-preview-empty">Pick an engine to preview the packet.</EmptyPreview>
            ) : (
              <>
                <CodePreview data-testid="handoff-preview">{packet.text}</CodePreview>
                <CharacterCount>{handoffCharCount(packet.chars)}</CharacterCount>
              </>
            )}
          </PreviewStack>
        </ScrollRegion>

        <DialogFooterRow>
          <Button variant="legacy-ghost" onClick={onCancel}>
            Cancel <KeyHint>esc</KeyHint>
          </Button>
          <Button
            data-testid="handoff-confirm"
            variant="legacy-primary"
            disabled={target === null}
            onClick={() => {
              if (target === null) return
              onHandoff(target, packet.text)
            }}
          >
            Handoff
          </Button>
        </DialogFooterRow>
      </DialogPanel>
    </DialogBackdrop>
  )
}
