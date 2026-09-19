import { useEffect, useMemo, useState } from 'react'
import logoUrl from '../assets/logo-chrome.svg'
import type { AgentKind } from '../houston/client'
import { BTN_PRIMARY } from './buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import {
  IconAgent,
  IconArrowUpRight,
  IconCheck,
  IconClose,
  IconGitFork,
  IconUser,
  IconUsers,
  type IconComponent
} from './icons'
import { engineGlyphColor } from './SessionPane'
import {
  AGENT_LABEL,
  COMPOSER_AGENTS,
  MAX_COUNT,
  SESSION_PRESETS,
  expandSlots,
  taskOverLimitMessage,
  type SessionPreset,
  type SessionSlot
} from './sessionPresets'
import { ICON_ROLE_CLS, Icon } from './Icon'
import {
  PICKER_LABEL_CLS,
  TILE_AGENT_CLS,
  TILE_BASE,
  TILE_IDLE,
  TILE_SELECTED
} from './pickerChrome'
import { Tooltip } from './Tooltip'
import { MATERIAL_CLS, materialAttrs } from './material'

export interface NewSessionComposerProps {
  workspaceName: string
  workspacePath: string
  onLaunch: (slots: SessionSlot[]) => void
  onCancel: () => void
}

const LABEL_CLS = PICKER_LABEL_CLS

const PRESET_GLYPH: Record<string, IconComponent> = {
  solo: IconUser,
  pair: IconUsers,
  workbench: IconArrowUpRight,
  swarm: IconGitFork
}

export function NewSessionComposer({
  workspaceName,
  workspacePath,
  onLaunch,
  onCancel
}: NewSessionComposerProps): React.JSX.Element {
  const [presetId, setPresetId] = useState<string | null>('solo')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [count, setCount] = useState(1)
  const [task, setTask] = useState('')

  const preset: SessionPreset | null = useMemo(
    () => SESSION_PRESETS.find((p) => p.id === presetId) ?? null,
    [presetId]
  )
  const overLimit = taskOverLimitMessage(task)
  const slots = useMemo(() => expandSlots(preset, agent, count, task), [preset, agent, count, task])
  const canLaunch = !overLimit

  const choosePreset = (p: SessionPreset): void => {
    setPresetId(p.id)
    setCount(p.count)
    setAgent(p.defaultAgent)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (canLaunch) onLaunch(slots)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onLaunch, slots, canLaunch])

  const sessionWord = count === 1 ? 'session' : 'sessions'

  return (
    <div
      data-testid="new-session-composer"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full grid grid-rows-[44px_minmax(0,1fr)_56px] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <div className="flex items-center gap-[10px] border-b border-[var(--border)] px-[14px]">
        <span className="inline-flex h-[var(--h-ctl-mini)] flex-none items-center gap-[6px] rounded-[var(--tr-radius-sm)] bg-[var(--card-hover)] pl-[7px] pr-[9px] [font-size:var(--tr-text-small-size)] font-bold text-[var(--text-primary)]">
          <img src={logoUrl} alt="" width={15} height={15} className="block flex-none" />
          <span className="max-w-[180px] truncate">{workspaceName}</span>
        </span>
        <span className="flex-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">
          New session
        </span>
        <Tooltip label={workspacePath}>
          <span className="min-w-0 truncate font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
            {workspacePath}
          </span>
        </Tooltip>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close"
          data-testid="new-session-close"
          onClick={onCancel}
          className={`inline-flex ${CONTROL_SIZE_SQUARE_CLS.small} flex-none items-center justify-center rounded-[var(--tr-radius-sm)] border-none bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]`}
        >
          <Icon glyph={IconClose} role="small" />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto px-6">
        <div className="mx-auto flex w-full max-w-[556px] flex-col gap-[14px] pb-8 pt-[14px]">
          <fieldset className="m-0 border-0 p-0">
            <legend className={`${LABEL_CLS} mb-[8px] p-0`}>Preset</legend>
            <div className="grid grid-cols-4 gap-[7px]">
              {SESSION_PRESETS.map((p) => {
                const selected = presetId === p.id
                const Glyph = PRESET_GLYPH[p.id] ?? IconUser
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-preset={p.id}
                    aria-pressed={selected}
                    onClick={() => choosePreset(p)}
                    className={`${TILE_BASE} ${selected ? TILE_SELECTED : TILE_IDLE} flex h-[58px] flex-col gap-[5px] overflow-hidden rounded-[var(--tr-radius-md)] px-[9px] pt-[9px] pb-0`}
                  >
                    <span className="flex items-center gap-[7px] leading-[15px]">
                      <Glyph
                        className={`${ICON_ROLE_CLS.ui} ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                      />
                      <span className="flex-1 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">
                        {p.name}
                      </span>
                      <span
                        className={`[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tabular-nums ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}`}
                      >
                        {p.count}
                      </span>
                    </span>
                    <span className="whitespace-normal [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[12.5px] text-[var(--text-muted)]">
                      {p.blurb}
                    </span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          <fieldset className="m-0 border-0 p-0">
            <legend className={`${LABEL_CLS} mb-[8px] p-0`}>Agent</legend>
            <div className="grid grid-cols-3 gap-[7px]">
              {COMPOSER_AGENTS.map((a) => {
                const selected = agent === a
                return (
                  <button
                    key={a}
                    type="button"
                    data-agent={a}
                    aria-pressed={selected}
                    onClick={() => setAgent(a)}
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
                        data-testid={`new-session-agent-check-${a}`}
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

          <fieldset className="m-0 border-0 p-0">
            <legend className={`${LABEL_CLS} mb-[8px] p-0`}>How many</legend>
            <div className="flex items-center gap-[5px]">
              {Array.from({ length: MAX_COUNT }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  data-count={n}
                  aria-pressed={count === n}
                  onClick={() => setCount(n)}
                  className={`${TILE_BASE} ${count === n ? TILE_SELECTED : TILE_IDLE} flex h-[var(--h-ctl)] w-[31px] items-center justify-center rounded-[var(--tr-radius-sm)] p-0 [font-size:var(--tr-text-small-size)] font-semibold tabular-nums ${count === n ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                >
                  {n}
                </button>
              ))}
              <span className="ml-[9px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">{sessionWord}</span>
            </div>
          </fieldset>

          <div>
            <label className={`${LABEL_CLS} mb-[8px]`} htmlFor="new-session-task">
              {count === 1 ? 'Task — optional' : 'Task — goes to every agent, optional'}
            </label>
            <textarea
              id="new-session-task"
              data-testid="new-session-task"
              rows={1}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={count === 1 ? 'What should it work on?' : 'What should they work on?'}
              className="block w-full min-h-[44px] max-h-[160px] resize-y rounded-[8px] border border-[var(--border)] bg-[var(--card-bg)] px-[12px] py-[11px] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[18px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:[border-color:var(--accent)] focus:outline-none focus-visible:[border-color:var(--accent)]"
            />
            {overLimit && (
              <p
                role="alert"
                data-testid="new-session-task-error"
                className="m-0 mt-[6px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--danger)]"
              >
                {overLimit}
              </p>
            )}
          </div>

          <section>
            <h2 className={`${LABEL_CLS} m-0 mb-[8px]`}>Will launch</h2>
            <div className="grid grid-cols-3 gap-[7px]" data-testid="new-session-preview">
              {slots.map((s) => (
                <div
                  key={s.index}
                  data-slot={s.index}
                  className="flex h-[var(--h-pill)] items-center gap-[9px] rounded-[var(--tr-radius-sm)] bg-[var(--card-bg)] pl-[10px] pr-[8px]"
                >
                  <span className="flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tabular-nums text-[var(--text-faint)]">
                    {s.index + 1}
                  </span>
                  <span className="flex-none" style={{ color: engineGlyphColor(s.agent) }}>
                    <IconAgent agent={s.agent} className={ICON_ROLE_CLS.ui} />
                  </span>
                  <span className="min-w-0 truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]">
                    {AGENT_LABEL[s.agent] ?? s.agent}
                    {s.roleLabel && <span className="text-[var(--text-muted)]"> · {s.roleLabel}</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div className="flex items-center gap-[10px] border-t border-[var(--border)] px-[14px]">
        <span
          data-testid="new-session-summary"
          className="flex-1 min-w-0 truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]"
        >
          {preset?.name ?? 'Custom'} · {count} {sessionWord} in {workspaceName}
        </span>
        <button
          type="button"
          data-testid="new-session-cancel"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-4)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="new-session-launch"
          disabled={!canLaunch}
          onClick={() => onLaunch(slots)}
          className={`btn ${BTN_PRIMARY} inline-flex h-8 items-center rounded-[var(--tr-radius-button)] px-[var(--space-5)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {count === 1
            ? `Launch ${AGENT_LABEL[slots[0]?.agent ?? agent] ?? agent}`
            : `Launch ${count} sessions`}
        </button>
      </div>
    </div>
  )
}
