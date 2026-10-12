import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HoustonClient } from '../../houston/client'
import type { SlackInfo } from '../../houston/generated/SlackInfo'
import type { TaskTrackerWorkspaceSettings } from '../../houston/generated/TaskTrackerWorkspaceSettings'
import { useHarness } from '../../houston/useHarness'
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
  const configure = (source: Exclude<Setup, null>): void => { dismiss(); setSetup(source) }
  const trackerState = (provider: 'github_issues' | 'notion'): React.JSX.Element => {
    if (!activeWorkspace) return <Text size="small" tone="muted">Choose a workspace</Text>
    if (!trackers) return <Text size="small" tone="muted">Loading…</Text>
    const setting = trackers.find((item) => item.provider === provider)
    return <StatusLabel size="small" status={setting?.last_error ? 'Failed' : setting?.enabled ? 'Watching' : 'Off'} />
  }
  return <>
    <Button ref={trigger} variant="secondary" icon={IconPlug} data-testid="tasks-sources" aria-expanded={open} aria-controls={open ? 'task-sources' : undefined} onClick={() => setOpen((value) => !value)}>Sources</Button>
    {open && createPortal(<PopoverPanel ref={panel} width="wide" top={position.top} left={position.left} visible aria-label="Where tasks come from" id="task-sources">
      <PopoverHeader><PopoverTitle>Where tasks come from</PopoverTitle></PopoverHeader>
      <PopoverBody>
        {!workspace && <Select aria-label="Sources workspace" value={activeWorkspace} onChange={setChosenWorkspace} options={workspaces.map((item) => ({ value: item.path, label: item.name }))} />}
        <Card>
          <Card.Row heading="Slack" meta="Mention the bot in a mapped channel to file a pending task. The owner starts it with a :white_check_mark: reaction."
            status={slack ? <StatusLabel size="small" status={!slack.enabled ? 'Off' : slack.connection === 'connected' ? 'Connected' : 'Reconnecting'} /> : <Text size="small" tone="muted">Loading…</Text>}
            action={<Button variant="link" size="sm" disabled={!client} data-testid="task-source-slack" onClick={() => configure('slack')}>Set up</Button>} />
          <Card.Row heading="GitHub issues" meta="Issues with a label you choose in this workspace’s repository." status={trackerState('github_issues')}
            action={<Button variant="link" size="sm" disabled={!client || !activeWorkspace} data-testid="task-source-github_issues" onClick={() => configure('github_issues')}>Set up</Button>} />
          <Card.Row heading="Notion" meta="Pages in a database you choose." status={trackerState('notion')}
            action={<Button variant="link" size="sm" disabled={!client || !activeWorkspace} data-testid="task-source-notion" onClick={() => configure('notion')}>Set up</Button>} />
          <Card.Row heading="Review" meta="Findings arrive as Suggested; you decide what becomes a task."
            status={state ? <StatusLabel size="small" status={state.routine?.enabled ? 'Watching' : 'Off'} /> : <Text size="small" tone="muted">{activeWorkspace ? 'Loading…' : 'Choose a workspace'}</Text>}
            action={<Button variant="link" size="sm" onClick={() => { dismiss(); setRailView('routines') }}>Set up</Button>} />
        </Card>
      </PopoverBody>
    </PopoverPanel>, document.body)}
    {setup === 'slack' && <ConnectionsIntegrations client={client} setupOnly onClose={() => { setSetup(null); trigger.current?.focus() }} />}
    <Drawer open={setup === 'github_issues' || setup === 'notion'} heading="Task sources" onClose={() => { setSetup(null); trigger.current?.focus() }}>
      {setup && setup !== 'slack' && <TaskTrackerSettingsSection client={client} workspace={activeWorkspace || null} workspaceName={activeName || null} initialProvider={setup} />}
    </Drawer>
  </>
}
