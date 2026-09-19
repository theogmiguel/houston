import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind } from '../houston/client'
import { BTN_GHOST, BTN_ICO, BTN_PRIMARY } from './buttonChrome'
import { MODAL_SCRIM_CLS } from './overlayChrome'
import { useFocusTrap } from './dialogFocus'
import { Icon, ICON_ROLE_CLS } from './Icon'
import { IconAgent, IconCheck, IconClose } from './icons'
import { AGENT_LABEL, COMPOSER_AGENTS } from './sessionPresets'
import { engineGlyphColor } from './SessionPane'
import {
  PICKER_LABEL_CLS,
  TILE_AGENT_CLS,
  TILE_BASE,
  TILE_IDLE,
  TILE_SELECTED
} from './pickerChrome'
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
    <div className={MODAL_SCRIM_CLS} onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pane-handoff-title"
        tabIndex={-1}
        data-testid="pane-handoff"
        className="pop flex h-[min(940px,92vh)] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--raised)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex flex-none items-center gap-2 border-b border-divider px-3.5 py-[11px]">
          <span
            id="pane-handoff-title"
            className="flex min-w-0 items-baseline gap-2 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]"
          >
            <span className="flex-none truncate">
              <span className="font-semibold">Handoff</span>
              <span className="text-[var(--text-faint)]"> from </span>
              {sourceLabel}
            </span>
            <span className="min-w-0 truncate text-[var(--text-faint)]">
              {shortCwd(source.cwd)}
            </span>
          </span>
          <button
            type="button"
            aria-label="Close handoff"
            className={`btn ${BTN_ICO} ml-auto flex-none`}
            onClick={onCancel}
          >
            <Icon glyph={IconClose} role="ui" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-10">
          <div className="mx-auto flex h-full w-full max-w-[620px] flex-col gap-[18px]">
            <div className="flex flex-col gap-1">
              <div className="[font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] text-[var(--text-primary)]">
                Same conversation. Different teammate.
              </div>
              <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
                The other engine gets the full thread plus your ask.
              </div>
            </div>

            <fieldset className="m-0 flex flex-col gap-[8px] border-0 p-0">
              <legend className={`${PICKER_LABEL_CLS} p-0`}>Handoff to</legend>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] gap-[8px]">
                {targets.map((a) => {
                  const selected = target === a
                  return (
                    <button
                      key={a}
                      type="button"
                      data-agent={a}
                      aria-pressed={selected}
                      onClick={() => setTarget(a)}
                      className={`${TILE_BASE} ${selected ? TILE_SELECTED : TILE_IDLE} ${TILE_AGENT_CLS}`}
                    >
                      <span className="flex-none" style={{ color: engineGlyphColor(a) }}>
                        <IconAgent agent={a} className={ICON_ROLE_CLS.ui} />
                      </span>
                      <span
                        className={`flex-1 truncate [font-size:var(--tr-text-small-size)] ${selected ? 'font-semibold text-[var(--text-primary)]' : 'font-medium text-[var(--text-muted)]'}`}
                      >
                        {AGENT_LABEL[a] ?? a}
                      </span>
                      {selected && (
                        <span
                          data-testid={`handoff-check-${a}`}
                          className="flex h-[14px] w-[14px] flex-none items-center justify-center rounded-full bg-[var(--accent)] text-white"
                        >
                          <Icon glyph={IconCheck} role="label" />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </fieldset>

            <div className="flex flex-col gap-[8px]">
              <label className={PICKER_LABEL_CLS} htmlFor="pane-handoff-ask">
                Ask
              </label>
              {}
              <textarea
                id="pane-handoff-ask"
                data-testid="handoff-ask"
                rows={3}
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                placeholder={HANDOFF_ASK_DEFAULT}
                className="block w-full resize-y rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] px-[12px] py-[11px] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[18px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:[border-color:var(--accent)] focus:outline-none focus-visible:[border-color:var(--accent)]"
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-[6px]">
              <div className={PICKER_LABEL_CLS}>They see</div>
              {target === null ? (
                <div
                  data-testid="handoff-preview-empty"
                  className="min-h-0 flex-1 rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--tool-code-bg)] px-[12px] py-[11px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]"
                >
                  Pick an engine to preview the packet.
                </div>
              ) : (
                <>
                  <pre
                    data-testid="handoff-preview"
                    className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--tool-code-bg)] px-[12px] py-[11px] [font-size:var(--tr-text-ui-size)] leading-[18px] text-[var(--text-muted)]"
                  >
                    {packet.text}
                  </pre>
                  <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
                    {handoffCharCount(packet.chars)}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-none items-center justify-end gap-2 border-t border-divider px-3.5 py-[11px]">
          <button type="button" className={`btn ${BTN_GHOST}`} onClick={onCancel}>
            Cancel <span className="opacity-55 font-normal">esc</span>
          </button>
          <button
            type="button"
            data-testid="handoff-confirm"
            className={`btn ${BTN_PRIMARY}`}
            disabled={target === null}
            onClick={() => {
              if (target === null) return
              onHandoff(target, packet.text)
            }}
          >
            Handoff
          </button>
        </div>
      </div>
    </div>
  )
}
