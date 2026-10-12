import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HoustonClient } from '../../houston/client'
import type { SlackInfo } from '../../houston/generated/SlackInfo'
import type { TaskTrackerWorkspaceSettings } from '../../houston/generated/TaskTrackerWorkspaceSettings'
import { useHarness, type HarnessState } from '../../houston/useHarness'
import { setRailView } from '../../railView'
import { ConnectionsIntegrations } from '../ConnectionsIntegrations'
import { TaskTrackerSettingsSection } from '../settings/TaskTrackerSettingsSection'
import { Button, Card, Drawer, Select, StatusLabel, Text } from '../ui'
import { PopoverBody, PopoverHeader, PopoverPanel, PopoverTitle } from '../ui/PopoverPanel'
import { IconPlug } from '../icons'

// Match the popover's token gutters; the small anchor gap separates it from its trigger.
const EDGE = 8
const ANCHOR_GAP = 6

type Setup = 'slack' | 'github_issues' | 'notion' | null

export function TasksSources({ client, workspace, workspaces }: {
  client: HoustonClient | null
  workspace: string
  workspaces: { path: string; name: string }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [setup, setSetup] = useState<Setup>(null)
  const [chosenWorkspace, setChosenWorkspace] = useState(workspace || workspaces[0]?.path || '')
  const activeWorkspace = workspace || chosenWorkspace
  const activeName = workspaces.find((item) => item.path === activeWorkspace)?.name ?? activeWorkspace
  const [slack, setSlack] = useState<SlackInfo | null>(null)
  const [trackers, setTrackers] = useState<TaskTrackerWorkspaceSettings[] | null>(null)
  const { state } = useHarness(client, activeWorkspace || null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const dismiss = useCallback(() => { setOpen(false); trigger.current?.focus() }, [])
  const firstWorkspace = workspaces[0]?.path ?? ''
  useEffect(() => { setOpen(false); setSetup(null); setChosenWorkspace(workspace || firstWorkspace) }, [workspace, firstWorkspace])
  useEffect(() => {
    setSlack(null)
    if (!client) return
    const off = client.subscribe('slack', (message) => { if (!message.refusal) setSlack(message.info) })
    client.slackGet()
    return off
  }, [client])
  useEffect(() => {
    setTrackers(null)
    if (!client || !activeWorkspace) return
    const off = client.subscribeAll((message) => {
      if (message.type === 'task_tracker_settings') {
        const matching = message.settings.filter((item) => item.workspace === activeWorkspace)
        setTrackers((current) => [...(current ?? []).filter((item) => !matching.some((next) => next.provider === item.provider)), ...matching])
      }
    })
    client.send({ type: 'task_tracker_settings_get', workspace: activeWorkspace })
    return off
  }, [client, activeWorkspace])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = panel.current?.getBoundingClientRect().width ?? 0
      const height = panel.current?.getBoundingClientRect().height ?? 0
      setPosition({ left: Math.max(EDGE, Math.min(rect.right - width, window.innerWidth - width - EDGE)), top: Math.max(EDGE, Math.min(rect.bottom + ANCHOR_GAP, window.innerHeight - height - EDGE)) })
    }
    place()
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false)
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); dismiss() } }
    panel.current?.querySelector<HTMLElement>('button, [tabindex="0"]')?.focus()
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key)
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
    }
  }, [open, dismiss])
  const connected = hasConnectedSources(slack, trackers, state)
  const configure = (source: Exclude<Setup, null>): void => { dismiss(); setSetup(source) }
  return <>
    <Button ref={trigger} variant="secondary" icon={IconPlug} data-testid="tasks-sources" aria-expanded={open} aria-controls={open ? 'task-sources' : undefined} onClick={() => setOpen((value) => !value)}>Sources{connected && <span aria-hidden="true"><StatusLabel status="Connected" variant="dot" /></span>}</Button>
    {open && createPortal(<PopoverPanel ref={panel} width="wide" top={position.top} left={position.left} visible aria-label="Where tasks come from" id="task-sources">
      <PopoverHeader description="Slack requests wait for the owner’s ✅ before an agent starts; review findings wait for your decision."><PopoverTitle>Where tasks come from</PopoverTitle></PopoverHeader>
      <TaskSourcesContent clientConnected={!!client} workspace={workspace} workspaces={workspaces} activeWorkspace={activeWorkspace}
        onWorkspace={setChosenWorkspace} slack={slack} trackers={trackers} harness={state} onConfigure={configure}
        onReview={() => { dismiss(); setRailView('routines') }} />
    </PopoverPanel>, document.body)}
    <TaskSourceSetup setup={setup} client={client} workspace={activeWorkspace} workspaceName={activeName}
      onClose={() => { setSetup(null); trigger.current?.focus() }} />
  </>
}

function TrackerSourceState({ workspace, trackers, provider }: {
  workspace: string
  trackers: TaskTrackerWorkspaceSettings[] | null
  provider: 'github_issues' | 'notion'
}): React.JSX.Element {
  if (!workspace) return <Text size="small" tone="muted">Choose a workspace</Text>
  if (!trackers) return <Text size="small" tone="muted">Loading…</Text>
  const setting = trackers.find((item) => item.provider === provider)
  return <StatusLabel size="small" status={setting?.last_error ? 'Failed' : setting?.enabled ? 'On' : 'Off'} />
}

function TaskSourcesContent({ clientConnected, workspace, workspaces, activeWorkspace, onWorkspace, slack, trackers, harness, onConfigure, onReview }: {
  clientConnected: boolean
  workspace: string
  workspaces: { path: string; name: string }[]
  activeWorkspace: string
  onWorkspace: (workspace: string) => void
  slack: SlackInfo | null
  trackers: TaskTrackerWorkspaceSettings[] | null
  harness: HarnessState | null
  onConfigure: (source: Exclude<Setup, null>) => void
  onReview: () => void
}): React.JSX.Element {
  return (
    <PopoverBody>
      {!workspace && <Select aria-label="Sources workspace" value={activeWorkspace} onChange={onWorkspace} options={workspaces.map((item) => ({ value: item.path, label: item.name }))} />}
      <div className="grid">
        <Card.Row layout="source" heading="Slack" meta={slackSourceCaption(slack, activeWorkspace)}
          status={slack ? <StatusLabel size="small" status={!slack.enabled ? 'Off' : slack.connection === 'connected' ? 'Connected' : 'Reconnecting'} /> : <Text size="small" tone="muted">Loading…</Text>}
          action={<Button variant="muted-link" size="sm" disabled={!clientConnected} data-testid="task-source-slack" onClick={() => onConfigure('slack')}>{slack?.enabled ? 'Edit' : 'Set up…'}</Button>} />
        <Card.Row layout="source" heading="GitHub issues" meta="Issues with a label you choose in this workspace’s repository." status={<TrackerSourceState workspace={activeWorkspace} trackers={trackers} provider="github_issues" />}
          action={<Button variant="muted-link" size="sm" disabled={!clientConnected || !activeWorkspace} data-testid="task-source-github_issues" onClick={() => onConfigure('github_issues')}>Set up…</Button>} />
        <Card.Row layout="source" heading="Notion" meta="Pages in a database you choose." status={<TrackerSourceState workspace={activeWorkspace} trackers={trackers} provider="notion" />}
          action={<Button variant="muted-link" size="sm" disabled={!clientConnected || !activeWorkspace} data-testid="task-source-notion" onClick={() => onConfigure('notion')}>Set up…</Button>} />
        <Card.Row layout="source" heading="Weekly review" meta="Findings arrive as Suggested; you decide what becomes a task."
          status={harness ? <StatusLabel size="small" status={harness.routine?.kind === 'harness_review' && harness.routine.enabled ? 'On' : 'Off'} /> : <Text size="small" tone="muted">{activeWorkspace ? 'Loading…' : 'Choose a workspace'}</Text>}
          action={<Button variant="muted-link" size="sm" onClick={onReview}>{harness?.routine?.kind === 'harness_review' ? 'Routines' : 'Set up…'}</Button>} />
      </div>
    </PopoverBody>
  )
}

function TaskSourceSetup({ setup, client, workspace, workspaceName, onClose }: {
  setup: Setup
  client: HoustonClient | null
  workspace: string
  workspaceName: string
  onClose: () => void
}): React.JSX.Element {
  return <>
    {setup === 'slack' && <ConnectionsIntegrations client={client} setupOnly onClose={onClose} />}
    <Drawer open={setup === 'github_issues' || setup === 'notion'} heading="Task sources" onClose={onClose}>
      {setup && setup !== 'slack' && <TaskTrackerSettingsSection client={client} workspace={workspace || null} workspaceName={workspaceName || null} initialProvider={setup} />}
    </Drawer>
  </>
}

function slackSourceCaption(info: SlackInfo | null, workspace: string): string {
  const channels = info?.channels.filter((channel) => channel.workspace === workspace).map((channel) => channel.channel_id) ?? []
  const prefix = channels.length ? `${channels.join(', ')} · ` : ''
  return `${prefix}Mention the bot in a mapped channel to file a task; the owner starts it with :white_check_mark:.`
}

function hasConnectedSources(slack: SlackInfo | null, trackers: TaskTrackerWorkspaceSettings[] | null, harness: HarnessState | null): boolean {
  if (slack?.enabled && slack.connection === 'connected') return true
  if (trackers?.some((tracker) => tracker.enabled && !tracker.last_error)) return true
  return harness?.routine?.kind === 'harness_review' && harness.routine.enabled
}
