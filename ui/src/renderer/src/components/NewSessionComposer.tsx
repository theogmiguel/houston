import { useEffect, useMemo, useState } from 'react'
import type { HoustonClient } from '../houston/client'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { RoleRoute } from '../houston/generated/RoleRoute'
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
import { Select } from './ui/Select'
import {
  Chip,
  InlineControlRow,
  PrimaryAction,
  ScrollableFormBody,
  LabeledControl,
  OptionFieldset,
  ActionFooter,
  LaunchComposerHeader,
  DockedFormPanel,
  FormSection,
  InlineSummary,
  CountStepper,
  FieldCounter,
  FieldError,
  FieldGroup,
  FormLabel,
  LaunchPresetCard,
  PresetGrid,
  RouteList,
  RouteNote,
  SectionHeading,
  LaunchSlotCard,
  SlotList,
  TaskInput,
  Segmented
} from './ui'

export interface NewSessionComposerProps {
  workspaceName: string
  workspacePath: string
  gridName: string
  client?: HoustonClient | null
  initialTarget?: 'this-grid' | 'new-grid'
  onPreviewChange?: (slots: SessionSlot[], target: 'this-grid' | 'new-grid') => void
  onLaunch: (slots: SessionSlot[], target: 'this-grid' | 'new-grid') => void
  onCancel: () => void
}

export function NewSessionComposer({
  workspaceName,
  workspacePath,
  gridName,
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
    <DockedFormPanel data-testid="new-session-composer">
      <LaunchComposerHeader workspaceName={workspaceName} workspacePath={workspacePath} gridName={gridName} target={target} onClose={onCancel} />

      <ScrollableFormBody>
        <Segmented aria-label="Launch target" leadingLabel="Launch into" value={target} onChange={setTarget} options={[
            { value: 'this-grid', label: 'This grid', testId: 'launch-target-this-grid' },
            { value: 'new-grid', label: 'New grid', testId: 'launch-target-new-grid' }
          ]} className="w-full" />
        <OptionFieldset legend="Preset">
          <PresetGrid>
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
          </PresetGrid>
        </OptionFieldset>

        <InlineControlRow>
          <LabeledControl as="label" label="Default agent" className="min-w-0">
            <Select aria-label="Default agent" value={agent} options={COMPOSER_AGENTS.map((value) => ({ value, label: AGENT_LABEL[value] ?? value }))}
              onChange={(value) => { setAgent(value as AgentKind); setAgentOverridden(true) }} />
          </LabeledControl>
          <LabeledControl as="group" label="How many">
            <CountStepper value={count} min={1} max={MAX_COUNT} onChange={setCount} />
          </LabeledControl>
        </InlineControlRow>

        <FormSection>
          <SectionHeading>Slots</SectionHeading>
          <SlotList data-testid="new-session-preview">
            {slots.map((s) => (
              <LaunchSlotCard key={s.index} slot={s} workspaceName={workspaceName} override={overrides[s.index] ?? {}}
                onAgentChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], agent: value } }))}
                onModelChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], model: value } }))}
                onEffortChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], effort: value } }))}
                onReset={() => setOverrides((current) => { const next = { ...current }; delete next[s.index]; return next })} />
            ))}
          </SlotList>
        </FormSection>

        <FieldGroup>
          <FormLabel htmlFor="new-session-task">
            Task — goes to every agent, optional
          </FormLabel>
          <TaskInput
            id="new-session-task"
            data-testid="new-session-task"
            rows={1}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={count === 1 ? 'What should it work on?' : 'What should they work on?'}
          />
          {overLimit && (
            <FieldError role="alert" data-testid="new-session-task-error">
              {overLimit}
            </FieldError>
          )}
          <FieldCounter>
            {taskByteLength(task).toLocaleString('en-US')} / 8,192 bytes
          </FieldCounter>
        </FieldGroup>

        <FormSection aria-label="Workspace routing">
          <div className="flex items-center justify-between gap-[var(--space-2)]">
            <SectionHeading>Workspace routing</SectionHeading>
            <Chip variant="state" label="Houston" />
          </div>
          {routes.length === 0
            ? <RouteNote>No routes · agents use their defaults</RouteNote>
            : <RouteList>{routes.map((route, index) => <RouteNote key={`${route.pattern}-${index}`}>{route.pattern} → {route.model}{route.effort ? ` · ${route.effort}` : ''}</RouteNote>)}</RouteList>}
        </FormSection>
      </ScrollableFormBody>

      <ActionFooter>
        <InlineSummary data-testid="new-session-summary">
          {preset?.name ?? 'Custom'} · {count} {sessionWord} in {workspaceName}
        </InlineSummary>
        <PrimaryAction data-testid="new-session-launch" disabled={!canLaunch} onClick={() => onLaunch(slots, target)}>
          Launch {slots.length} {sessionWord} <small>Ctrl ↵</small>
        </PrimaryAction>
      </ActionFooter>
    </DockedFormPanel>
  )
}
