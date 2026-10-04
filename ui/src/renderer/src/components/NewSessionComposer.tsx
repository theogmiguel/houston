import { useEffect, useMemo, useState } from 'react'
import logoUrl from '../assets/logo-chrome.svg'
import type { HoustonClient } from '../houston/client'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { RoleRoute } from '../houston/generated/RoleRoute'
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
  resolveSlots,
  taskOverLimitMessage,
  type SessionPreset,
  type SessionSlot
} from './sessionPresets'
import type { SlotOverrides } from './sessionPresets'
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
import type { LayoutNode } from '../layout/tree'
import { LaunchComposerHeader, LaunchLayoutPreview, LaunchSlotCard, LaunchWorkspaceBadge } from './ui'

export interface NewSessionComposerProps {
  workspaceName: string
  workspacePath: string
  client?: HoustonClient | null
  initialTarget?: 'this-grid' | 'new-grid'
  tree?: LayoutNode | null
  onLaunch: (slots: SessionSlot[], target: 'this-grid' | 'new-grid') => void
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
  client = null,
  initialTarget = 'this-grid',
  tree = null,
  onLaunch,
  onCancel
}: NewSessionComposerProps): React.JSX.Element {
  const [presetId, setPresetId] = useState<string | null>('solo')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [count, setCount] = useState(1)
  const [task, setTask] = useState('')
  const [target, setTarget] = useState<'this-grid' | 'new-grid'>(initialTarget)
  const [hoveredPreset, setHoveredPreset] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Record<number, SlotOverrides>>({})
  const [routes, setRoutes] = useState<RoleRoute[]>([])

  useEffect(() => {
    if (!client) return
    const off = client.subscribe('workspace_routing', (message) => {
      if (message.workspace === workspacePath) setRoutes(message.routes)
    })
    client.workspaceRoutingGet(workspacePath)
    return off
  }, [client, workspacePath])

  const preset: SessionPreset | null = useMemo(
    () => SESSION_PRESETS.find((p) => p.id === presetId) ?? null,
    [presetId]
  )
  const previewPreset = useMemo(
    () => SESSION_PRESETS.find((value) => value.id === hoveredPreset) ?? preset,
    [hoveredPreset, preset]
  )
  const overLimit = taskOverLimitMessage(task)
  const slots = useMemo(
    () => resolveSlots(previewPreset, agent, hoveredPreset ? previewPreset?.count ?? count : count, task, { routes, overrides }),
    [previewPreset, hoveredPreset, agent, count, task, routes, overrides]
  )
  const invalidSlot = slots.find((slot) => slot.invalidReason)
  const canLaunch = !overLimit && !invalidSlot

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
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target instanceof HTMLTextAreaElement && e.target.dataset.testid === 'new-session-task') {
        e.preventDefault()
        if (canLaunch) onLaunch(slots, target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onLaunch, slots, canLaunch, target])

  const sessionWord = count === 1 ? 'session' : 'sessions'

  return (
    <div
      data-testid="new-session-composer"
      {...materialAttrs('base')}
      className={`flex-none min-w-0 h-full w-[380px] grid grid-rows-[44px_minmax(0,1fr)_56px] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <LaunchComposerHeader>
        <LaunchWorkspaceBadge logoUrl={logoUrl} workspaceName={workspaceName} />
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
      </LaunchComposerHeader>

      <div className="min-h-0 overflow-y-auto px-6">
        <div className="mx-auto flex w-full max-w-[556px] flex-col gap-[14px] pb-8 pt-[14px]">
          <fieldset className="m-0 flex flex-col gap-[var(--space-2)] border-0 p-0">
            <legend className={`${LABEL_CLS} p-0`}>Launch into</legend>
            <div className="flex gap-[5px]">
              {([['this-grid', 'This grid'], ['new-grid', 'New grid']] as const).map(([value, label]) => (
                <button key={value} type="button" data-target={value} aria-pressed={target === value} onClick={() => setTarget(value)}
                  className={`${TILE_BASE} ${target === value ? TILE_SELECTED : TILE_IDLE} flex-1`}>
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <LaunchLayoutPreview tree={tree} count={slots.length} target={target} />
          <fieldset className="m-0 flex flex-col gap-[var(--space-2)] border-0 p-0">
            <legend className={`${LABEL_CLS} p-0`}>Preset</legend>
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
                    onMouseEnter={() => setHoveredPreset(p.id)}
                    onMouseLeave={() => setHoveredPreset(null)}
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

          <fieldset className="m-0 flex flex-col gap-[var(--space-2)] border-0 p-0">
            <legend className={`${LABEL_CLS} p-0`}>Agent</legend>
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

          <fieldset className="m-0 flex flex-col gap-[var(--space-2)] border-0 p-0">
            <legend className={`${LABEL_CLS} p-0`}>How many</legend>
            <div className="flex items-center gap-[var(--space-1-5)]">
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
              <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">{sessionWord}</span>
            </div>
          </fieldset>

          <div className="flex flex-col gap-[var(--space-1-5)]">
            <label className={LABEL_CLS} htmlFor="new-session-task">
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
                className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--danger)]"
              >
                {overLimit}
              </p>
            )}
          </div>

          <section className="flex flex-col gap-[var(--space-2)]">
            <h2 className={`${LABEL_CLS} m-0`}>Slots</h2>
            <div className="grid grid-cols-1 gap-[7px]" data-testid="new-session-preview">
              {slots.map((s) => (
                <LaunchSlotCard key={s.index} slot={s} workspaceName={workspaceName} override={overrides[s.index] ?? {}}
                  onAgentChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], agent: value } }))}
                  onModelChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], model: value } }))}
                  onEffortChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], effort: value } }))} />
              ))}
            </div>
          </section>
          <section aria-label="Workspace routing" className="flex flex-col gap-[var(--space-2)]">
            <h2 className={`${LABEL_CLS} m-0`}>Workspace routing</h2>
            {routes.length === 0
              ? <span className="[font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">No routes · agents use their defaults</span>
              : <div className="flex flex-wrap gap-[var(--space-2)]">{routes.map((route, index) => <span key={`${route.pattern}-${index}`} className="[font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">{route.pattern} → {route.model}{route.effort ? ` · ${route.effort}` : ''}</span>)}</div>}
          </section>
          <section className="flex flex-col gap-[var(--space-2)]">
            <h2 className={`${LABEL_CLS} m-0`}>O que cada parte precisa</h2>
            <div className="flex flex-wrap gap-[var(--space-1)] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">
              {['preset', 'profile', 'agent default', 'workspace setting', 'user override'].map((source) => <span key={source}>{source}</span>)}
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
          onClick={() => onLaunch(slots, target)}
          className={`btn ${BTN_PRIMARY} inline-flex h-8 items-center rounded-[var(--tr-radius-button)] px-[var(--space-5)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          Launch <small>Ctrl ↵</small>
        </button>
      </div>
    </div>
  )
}
