import { useEffect, useMemo, useState } from 'react'
import logoUrl from '../assets/logo-chrome.svg'
import type { HoustonClient } from '../houston/client'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { RoleRoute } from '../houston/generated/RoleRoute'
import { BTN_PRIMARY } from './buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { IconClose } from './icons'
import {
  AGENT_LABEL,
  COMPOSER_AGENTS,
  MAX_COUNT,
  SESSION_PRESETS,
  resolveSlots,
  taskByteLength,
  taskOverLimitMessage,
  type SessionPreset,
  type SessionSlot
} from './sessionPresets'
import type { SlotOverrides } from './sessionPresets'
import { Icon } from './Icon'
import { PICKER_LABEL_CLS } from './pickerChrome'
import { Tooltip } from './Tooltip'
import { Select } from './Select'
import { MATERIAL_CLS, materialAttrs } from './material'
import { Chip, LaunchComposerHeader, LaunchPresetCard, LaunchSlotCard, LaunchWorkspaceBadge, Segmented } from './ui'

export interface NewSessionComposerProps {
  workspaceName: string
  workspacePath: string
  client?: HoustonClient | null
  initialTarget?: 'this-grid' | 'new-grid'
  onPreviewChange?: (slots: SessionSlot[], target: 'this-grid' | 'new-grid') => void
  onLaunch: (slots: SessionSlot[], target: 'this-grid' | 'new-grid') => void
  onCancel: () => void
}

const LABEL_CLS = PICKER_LABEL_CLS

export function NewSessionComposer({
  workspaceName,
  workspacePath,
  client = null,
  initialTarget = 'this-grid',
  onPreviewChange,
  onLaunch,
  onCancel
}: NewSessionComposerProps): React.JSX.Element {
  const [presetId, setPresetId] = useState<string | null>('pair')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [agentOverridden, setAgentOverridden] = useState(false)
  const [count, setCount] = useState(2)
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
  const overLimit = taskOverLimitMessage(task)
  const slots = useMemo(
    () => resolveSlots(preset, agent, count, task, { routes, overrides, defaultAgentSource: agentOverridden ? 'user override' : 'preset' }),
    [preset, agent, agentOverridden, count, task, routes, overrides]
  )
  const previewSlots = useMemo(() => {
    const previewPreset = SESSION_PRESETS.find((value) => value.id === hoveredPreset) ?? preset
    return resolveSlots(previewPreset, agent, hoveredPreset ? previewPreset?.count ?? count : count, task, { routes, overrides, defaultAgentSource: agentOverridden ? 'user override' : 'preset' })
  }, [hoveredPreset, preset, agent, agentOverridden, count, task, routes, overrides])
  const invalidSlot = slots.find((slot) => slot.invalidReason)
  const canLaunch = !overLimit && !invalidSlot

  const choosePreset = (p: SessionPreset): void => {
    setHoveredPreset(null)
    setPresetId(p.id)
    setCount(p.count)
    setAgent(p.defaultAgent)
    setAgentOverridden(false)
  }

  useEffect(() => {
    onPreviewChange?.(hoveredPreset ? previewSlots : slots, target)
  }, [hoveredPreset, previewSlots, slots, target, onPreviewChange])

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
      className={`flex-none min-w-0 h-full w-[560px] max-w-[48vw] grid grid-rows-[44px_minmax(0,1fr)_56px] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <LaunchComposerHeader>
        <LaunchWorkspaceBadge logoUrl={logoUrl} workspaceName={workspaceName} />
        <span className="flex-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">
          New sessions
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

      <div className="min-h-0 overflow-y-auto px-5">
        <div className="mx-auto flex w-full max-w-[556px] flex-col gap-[var(--space-3)] pb-8 pt-[14px]">
          <Segmented aria-label="Launch target" leadingLabel="Launch into" value={target} onChange={setTarget} options={[
              { value: 'this-grid', label: 'This grid', testId: 'launch-target-this-grid' },
              { value: 'new-grid', label: 'New grid', testId: 'launch-target-new-grid' }
            ]} className="w-full" />
          <fieldset className="m-0 flex flex-col gap-[var(--space-2)] border-0 p-0">
            <legend className={`${LABEL_CLS} p-0`}>Preset</legend>
            <div className="grid grid-cols-4 gap-[7px]">
              {SESSION_PRESETS.map((p) => {
                const selected = presetId === p.id
                return (
                  <LaunchPresetCard
                    key={p.id}
                    id={p.id}
                    name={p.name}
                    blurb={p.blurb}
                    count={p.count}
                    selected={selected}
                    onSelect={() => choosePreset(p)}
                    onPreviewStart={() => setHoveredPreset(p.id)}
                    onPreviewEnd={() => setHoveredPreset(null)}
                  />
                )
              })}
            </div>
          </fieldset>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-[var(--space-3)]">
            <label className="flex min-w-0 flex-col gap-[var(--space-1)]">
              <span className={LABEL_CLS}>Default agent</span>
              <Select aria-label="Default agent" value={agent} options={COMPOSER_AGENTS.map((value) => ({ value, label: AGENT_LABEL[value] ?? value }))}
                onChange={(value) => { setAgent(value as AgentKind); setAgentOverridden(true) }} />
            </label>
            <div className="flex flex-col gap-[var(--space-1)]">
              <span className={LABEL_CLS}>How many</span>
              <div className="flex h-[var(--h-ctl)] items-center rounded-[var(--tr-radius-sm)] border border-[var(--border)]">
                <button type="button" aria-label="Fewer" disabled={count <= 1} onClick={() => setCount((value) => Math.max(1, value - 1))} className="h-full w-[26px] border-0 bg-transparent text-[var(--text-secondary)] disabled:opacity-40">−</button>
                <span data-testid="new-session-count" className="min-w-[22px] text-center tabular-nums [font-size:var(--tr-text-small-size)]">{count}</span>
                <button type="button" aria-label="More" disabled={count >= MAX_COUNT} onClick={() => setCount((value) => Math.min(MAX_COUNT, value + 1))} className="h-full w-[26px] border-0 bg-transparent text-[var(--text-secondary)] disabled:opacity-40">+</button>
              </div>
            </div>
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

          <div className="flex flex-col gap-[var(--space-1-5)]">
            <label className={LABEL_CLS} htmlFor="new-session-task">
              Task — goes to every agent, optional
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
            <span className="self-end font-mono [font-size:var(--tr-text-micro-size)] text-[var(--text-faint)]">
              {taskByteLength(task).toLocaleString('en-US')} / 8,192 bytes
            </span>
          </div>

          <section aria-label="Workspace routing" className="flex flex-col gap-[var(--space-2)]">
            <div className="flex items-center justify-between gap-[var(--space-2)]">
              <h2 className={`${LABEL_CLS} m-0`}>Workspace routing</h2>
              <Chip variant="state" label="Houston" />
            </div>
            {routes.length === 0
              ? <span className="[font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">No routes · agents use their defaults</span>
              : <div className="flex flex-wrap gap-[var(--space-2)]">{routes.map((route, index) => <span key={`${route.pattern}-${index}`} className="[font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">{route.pattern} → {route.model}{route.effort ? ` · ${route.effort}` : ''}</span>)}</div>}
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
          data-testid="new-session-launch"
          disabled={!canLaunch}
          onClick={() => onLaunch(slots, target)}
          className={`btn ${BTN_PRIMARY} inline-flex h-8 items-center rounded-[var(--tr-radius-button)] px-[var(--space-5)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          Launch {slots.length} {sessionWord} <small>Ctrl ↵</small>
        </button>
      </div>
    </div>
  )
}
