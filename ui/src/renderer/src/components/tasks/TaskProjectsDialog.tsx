import { useEffect, useRef, useState } from 'react'
import type { TaskProject, TaskTrackerProvider } from '../../houston/taskDomain'
import type { TaskProjectDraft, TaskProjects } from '../../houston/useTaskProjects'
import { useFocusRestore, useFocusTrap } from '../dialogFocus'
import { IconClose, IconFolder, IconPlus } from '../icons'
import {
  Button, DialogBackdrop, DialogBody, DialogPanel, DialogTitle, EmptyState, Field, Inline, ListDetail, Notice,
  Select, Stack, Text, TextArea, TextInput, type ListDetailItem
} from '../ui'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role="combobox"]'

export function TaskProjectsDialog({ projects, workspaces, initialWorkspace, onClose }: {
  projects: TaskProjects
  workspaces: { path: string; name: string }[]
  initialWorkspace: string
  onClose: () => void
}): React.JSX.Element {
  const [workspace, setWorkspace] = useState(initialWorkspace || workspaces[0]?.path || '')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  // Ids present when New project was pressed; the first id outside it is the created project.
  const knownIds = useRef<Set<number> | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  useFocusRestore(dialogRef, newRef)
  const trapTab = useFocusTrap(dialogRef, FOCUSABLE)
  const inWorkspace = (projects.projects ?? []).filter((project) => project.workspace === workspace)
  const items: Array<ListDetailItem & { project: TaskProject }> = [
    ...inWorkspace.filter((project) => project.archived_at_ms == null).map((project) => ({ id: String(project.id), title: project.name, section: 'Active', project })),
    ...inWorkspace.filter((project) => project.archived_at_ms != null).map((project) => ({ id: String(project.id), title: project.name, sub: 'Archived', section: 'Archived', project }))
  ]
  const selection = items.some((item) => item.id === selectedId) ? selectedId : items[0]?.id ?? null
  const syncStates = projects.syncStates[workspace] ?? {}
  useEffect(() => {
    const known = knownIds.current
    const created = known && projects.projects?.find((project) => project.workspace === workspace && !known.has(project.id))
    if (!created) return
    knownIds.current = null
    setSelectedId(String(created.id))
    setRenaming(created.id)
  }, [projects.projects, workspace])
  const createProject = (): void => {
    knownIds.current = new Set(inWorkspace.map((project) => project.id))
    projects.saveProject(workspace, null, { name: 'New project', external_url: null, tracker_description: null, local_decisions: [] })
  }

  return (
    <DialogBackdrop onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <DialogPanel
        ref={dialogRef}
        size="listDetail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-projects-title"
        data-testid="task-projects-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
          trapTab(event)
        }}
      >
        <DialogTitle layout="between">
          <span id="task-projects-title">Projects</span>
          <Inline gap="small">
            <Button ref={newRef} variant="secondary" size="sm" icon={IconPlus} disabled={!workspace || projects.busy} onClick={createProject}>New project</Button>
            <Button variant="icon" icon={IconClose} aria-label="Close projects" onClick={onClose} />
          </Inline>
        </DialogTitle>
        <DialogBody variant="scroll">
          {workspaces.length > 1 && <Select aria-label="Workspace" data-testid="task-projects-workspace" value={workspace} options={workspaces.map((item) => ({ value: item.path, label: item.name }))} onChange={(value) => { setWorkspace(value); setSelectedId(null) }} />}
          {projects.error && <Notice tone="danger">{projects.error}</Notice>}
          {projects.projects === null ? <Text role="status" aria-busy="true" tone="muted">Loading projects…</Text> : <ListDetail
            items={items}
            selectedId={selection}
            onSelect={setSelectedId}
            backLabel="Projects"
            listEmpty={<EmptyState icon={IconFolder} heading="No projects yet" description="Create a project to group this workspace’s deliveries and their slice tasks." copy="compact" />}
            renderDetail={(item) => item
              ? <ProjectEditor key={item.project.id} project={item.project} rename={renaming === item.project.id} busy={projects.busy} onSave={(draft) => projects.saveProject(item.project.workspace, item.project, draft)} onArchive={(archived) => projects.archiveProject(item.project, archived)} />
              : <EmptyState icon={IconFolder} heading="Select a project" description="Choose a project to edit its tracker link and decisions." copy="compact" />}
          />}
          <TrackerSyncStatus states={syncStates} />
        </DialogBody>
      </DialogPanel>
    </DialogBackdrop>
  )
}

function ProjectEditor({ project, rename, busy, onSave, onArchive }: {
  project: TaskProject
  rename: boolean
  busy: boolean
  onSave: (draft: TaskProjectDraft) => void
  onArchive: (archived: boolean) => void
}): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const [url, setUrl] = useState(project.external_url ?? '')
  const [decisions, setDecisions] = useState(project.local_decisions.join('\n'))
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!rename) return
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [rename, project.id])
  useEffect(() => {
    setName(project.name)
    setUrl(project.external_url ?? '')
    setDecisions(project.local_decisions.join('\n'))
  }, [project.id, project.revision, project.name, project.external_url, project.local_decisions])
  const archived = project.archived_at_ms != null
  return (
    <Stack as="section" gap={3} aria-label="Project details">
      <Field label="Project name"><TextInput ref={nameRef} aria-label="Project name" value={name} disabled={archived} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="External project URL"><TextInput aria-label="External project URL" type="url" value={url} disabled={archived} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></Field>
      {project.project_external_id && <Text size="small" tone="muted">Tracker project ID: {project.project_external_id}</Text>}
      {project.tracker_description && <Notice tone="info">Imported tracker context — unverified. {project.tracker_description}</Notice>}
      <Field label="Local corrections and decisions"><TextArea aria-label="Local corrections and decisions" rows={4} value={decisions} disabled={archived} onChange={(event) => setDecisions(event.target.value)} placeholder="One decision per line" /></Field>
      <Inline wrap gap="small">
        {!archived && <Button variant="primary" disabled={busy || name.trim() === ''} onClick={() => onSave({ name, external_url: url || null, tracker_description: project.tracker_description ?? null, local_decisions: decisions.split('\n').map((line) => line.trim()).filter(Boolean) })}>Save project</Button>}
        <Button variant="ghost" onClick={() => onArchive(!archived)}>{archived ? 'Restore project' : 'Archive project'}</Button>
      </Inline>
    </Stack>
  )
}

function TrackerSyncStatus({ states }: { states: Partial<Record<TaskTrackerProvider, { at: number | null; error: string | null }>> }): React.JSX.Element | null {
  const rows = (Object.keys(states) as TaskTrackerProvider[]).flatMap((provider) => states[provider] ? [{ provider, ...states[provider] }] : [])
  if (rows.length === 0) return null
  return <Stack gap={1}>
    {rows.map(({ provider, at, error }) => <Text key={provider} role="status" size="small" tone={error ? 'danger' : 'muted'}>{providerLabel(provider)} sync: {error ? `Error: ${error}` : at == null ? 'No completed sync' : `Last sync ${new Date(at).toLocaleString()}`}</Text>)}
  </Stack>
}

function providerLabel(provider: TaskTrackerProvider): string {
  return provider === 'github_issues' ? 'GitHub Issues' : provider === 'notion' ? 'Notion' : 'Slack'
}
