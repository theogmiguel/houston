import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HoustonClient } from '../houston/client'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { AgentProfile } from '../houston/generated/AgentProfile'
import type { TransferExportSummary } from '../houston/generated/TransferExportSummary'
import type { TransferFileSummary } from '../houston/generated/TransferFileSummary'
import type { TransferImportResult } from '../houston/generated/TransferImportResult'
import type { TransferPane } from '../houston/generated/TransferPane'
import type { TransferProfileChoice } from '../houston/generated/TransferProfileChoice'
import type { TransferRefusal } from '../houston/generated/TransferRefusal'
import type { TransferSkipped } from '../houston/generated/TransferSkipped'
import type { TransferStage } from '../houston/generated/TransferStage'
import {
  exportTransfer,
  importTransfer,
  inspectTransfer,
  listenTransferOpen,
  pickTransferDestination,
  pickTransferFile,
  takeLaunchTransferFile,
  transferFileName,
  TRANSFER_EVENT,
  TRANSFER_STAGE_LABEL,
  type TransferOpen,
  type TransferReply
} from '../houston/transfer'
import { wslWorkspaceOf } from '../houston/environments'
import type { Workspace } from '../houston/generated/Workspace'
import { collectTransferGrids } from '../layout/transferGrids'
import { useNativeOverlaySuppression } from '../layout/nativeSuppression'
import { useFocusTrap } from './dialogFocus'
import { Button, DialogActions, DialogBackdrop, DialogBody, DialogDescription, DialogPanel, DialogTitle, FormGrid, FormGridLabel, Inline, Notice, Select, Spinner, Stack, Text, TextInput } from './ui'

const PROVIDER_NAME: Partial<Record<AgentKind, string>> = { claude: 'Claude Code', codex: 'Codex' }
const OS_NAME: Record<string, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS' }
const DEFAULT_ACCOUNT = ''

type Outcome<T> = { kind: 'idle' } | { kind: 'running'; stage: TransferStage | null } | TransferReply<T>

function providerName(provider: AgentKind): string {
  return PROVIDER_NAME[provider] ?? provider
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One shape for every refusal: what is wrong, the exact paths or values, and the fix. */
export function TransferRefusalView({ refusal }: { refusal: TransferRefusal }): React.JSX.Element {
  return (
    <Stack gap={2} data-testid="transfer-refusal">
      <Notice tone="danger" variant="callout">{refusal.problem}</Notice>
      {refusal.items.length > 0 && (
        <Stack gap={1} role="list" aria-label="Details">
          {refusal.items.map((item) => <Text key={item} as="div" role="listitem" size="small" mono breakAll tone="secondary">{item}</Text>)}
        </Stack>
      )}
      {refusal.steps.length > 0 && (
        <Stack gap={1}>
          <Text size="small" weight="semibold" tone="primary">To continue</Text>
          <Stack gap={1} role="list">
            {refusal.steps.map((step) => <Text key={step} as="div" role="listitem" size="small" tone="secondary">{step}</Text>)}
          </Stack>
        </Stack>
      )}
    </Stack>
  )
}

function PaneList({ panes, skipped }: { panes: TransferPane[]; skipped: TransferSkipped[] }): React.JSX.Element {
  return (
    <Stack gap={2}>
      <Stack gap={1} role="list" aria-label="Panes in the file">
        {panes.map((pane) => (
          <Text key={pane.session} as="div" role="listitem" size="small" tone="secondary">
            <Text size="small" weight="semibold" tone="primary">{pane.title}</Text> · {providerName(pane.provider)} · {pane.checkout}{pane.profile_label ? ` · profile ${pane.profile_label}` : ''}
          </Text>
        ))}
      </Stack>
      {skipped.length > 0 && (
        <Stack gap={1}>
          <Text size="small" weight="semibold" tone="primary">Not transferred</Text>
          <Stack gap={1} role="list" aria-label="Panes not transferred">
            {skipped.map((pane) => <Text key={pane.session} as="div" role="listitem" size="small" tone="muted">{pane.title}: {pane.reason}</Text>)}
          </Stack>
        </Stack>
      )}
    </Stack>
  )
}

function Progress({ stage }: { stage: TransferStage | null }): React.JSX.Element {
  return <Inline gap="small"><Spinner label="Working" /><Text size="small" tone="muted">{stage ? TRANSFER_STAGE_LABEL[stage] : 'Starting'}</Text></Inline>
}

function useDialogFrame(onClose: () => void): { root: React.RefObject<HTMLDivElement | null>; onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void } {
  const root = useRef<HTMLDivElement>(null)
  const trapFocus = useFocusTrap(root, ':is(button, input, [tabindex="0"]):not([disabled])')
  useNativeOverlaySuppression('modal', true, root)
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('input, button')?.focus()
  }, [])
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    if (event.key === 'Tab') { event.stopPropagation(); trapFocus(event) }
  }
  return { root, onKeyDown }
}

function Frame({ heading, onClose, frame, children, actions }: { heading: string; onClose: () => void; frame: ReturnType<typeof useDialogFrame>; children: React.ReactNode; actions: React.ReactNode }): React.JSX.Element {
  return createPortal(
    <DialogBackdrop onMouseDown={onClose}>
      <DialogPanel size="wide" ref={frame.root} role="dialog" aria-modal="true" aria-labelledby="workspace-transfer-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={frame.onKeyDown} data-testid="workspace-transfer">
        <DialogTitle id="workspace-transfer-title">{heading}</DialogTitle>
        <DialogBody variant="bounded">{children}</DialogBody>
        <DialogActions variant="row">{actions}</DialogActions>
      </DialogPanel>
    </DialogBackdrop>, document.body
  )
}

function PassphraseFields({ passphrase, confirm, onPassphrase, onConfirm, mismatch }: { passphrase: string; confirm?: string; onPassphrase: (value: string) => void; onConfirm?: (value: string) => void; mismatch?: boolean }): React.JSX.Element {
  return (
    <FormGrid>
      <FormGridLabel htmlFor="transfer-passphrase">Passphrase</FormGridLabel>
      <TextInput variant="form" id="transfer-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(event) => onPassphrase(event.target.value)} />
      {onConfirm && <>
        <FormGridLabel htmlFor="transfer-passphrase-confirm">Repeat</FormGridLabel>
        <TextInput variant="form" id="transfer-passphrase-confirm" type="password" autoComplete="new-password" value={confirm} aria-invalid={mismatch} onChange={(event) => onConfirm(event.target.value)} />
        {mismatch && <Text as="p" size="small" tone="danger" flush role="alert" className="col-start-2">The passphrases differ.</Text>}
      </>}
    </FormGrid>
  )
}

/** Workspaces in a WSL environment are refused by name in this version. */
export function wslRefusal(workspace: string): TransferRefusal | null {
  const wsl = wslWorkspaceOf(workspace)
  if (!wsl) return null
  return {
    code: 'wsl_workspace',
    problem: `${workspace} is in the WSL environment ${wsl.distro}, and workspace transfer does not support WSL environments yet.`,
    items: [workspace],
    steps: ["Transfer a workspace on this computer's own file system instead."]
  }
}

export function ExportTransferDialog({ client, workspace, name, onClose }: { client: HoustonClient; workspace: string; name: string; onClose: () => void }): React.JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [outcome, setOutcome] = useState<Outcome<TransferExportSummary>>(() => {
    const refusal = wslRefusal(workspace)
    return refusal ? { kind: 'refused', refusal } : { kind: 'idle' }
  })
  const frame = useDialogFrame(onClose)
  const mismatch = confirm !== '' && confirm !== passphrase
  const ready = passphrase !== '' && passphrase === confirm && outcome.kind !== 'running'
  const run = async (): Promise<void> => {
    if (!ready) return
    const destination = await pickTransferDestination(transferFileName(name))
    if (!destination) return
    setOutcome({ kind: 'running', stage: null })
    const reply = await exportTransfer(client, { workspace, destination, passphrase, grids: collectTransferGrids(workspace) }, (stage) => setOutcome({ kind: 'running', stage }))
    setPassphrase('')
    setConfirm('')
    setOutcome(reply)
  }
  let body: React.ReactNode
  let actions: React.ReactNode = <Button variant="primary" onClick={onClose}>Close</Button>
  if (outcome.kind === 'ok') {
    const summary = outcome.value
    body = <Stack gap={3}>
      <DialogDescription>Saved {summary.panes.length === 1 ? '1 pane' : `${summary.panes.length} panes`} to <Text mono breakAll tone="primary">{summary.file}</Text> ({sizeLabel(summary.bytes)}). Their agents stopped on this computer; resuming one here starts a fork of the conversation.</DialogDescription>
      <PaneList panes={summary.panes} skipped={summary.skipped} />
      {summary.skipped_links.length > 0 && <Text as="p" size="small" tone="muted" flush>Symbolic links not carried: {summary.skipped_links.join(', ')}</Text>}
      <Text as="p" size="small" tone="muted" flush>Move the file to the other computer yourself and import it there with the same passphrase.</Text>
    </Stack>
  } else if (outcome.kind === 'refused') {
    body = <TransferRefusalView refusal={outcome.refusal} />
    actions = wslWorkspaceOf(workspace)
      ? <Button variant="primary" onClick={onClose}>Close</Button>
      : <><Button variant="secondary" onClick={onClose}>Close</Button><span className="flex-1" /><Button variant="primary" onClick={() => setOutcome({ kind: 'idle' })}>Try again</Button></>
  } else if (outcome.kind === 'error') {
    body = <Notice tone="danger" variant="callout">{outcome.message}</Notice>
  } else {
    body = <Stack gap={3}>
      <DialogDescription>Saves this workspace's Claude and Codex conversations and its code state in one encrypted file, so the work continues on another computer.</DialogDescription>
      <Text as="p" size="small" tone="muted" flush>The file holds commits that no remote has, uncommitted changes, untracked files and the full conversations, including everything the agents read. Houston sends nothing over the network. The exported agents stop here.</Text>
      <PassphraseFields passphrase={passphrase} confirm={confirm} onPassphrase={setPassphrase} onConfirm={setConfirm} mismatch={mismatch} />
      {outcome.kind === 'running' && <Progress stage={outcome.stage} />}
    </Stack>
    actions = <><Button variant="secondary" onClick={onClose} disabled={outcome.kind === 'running'}>Cancel</Button><span className="flex-1" /><Button variant="primary" disabled={!ready} onClick={() => void run()}>Export</Button></>
  }
  return <Frame heading={`Export ${name}`} onClose={onClose} frame={frame} actions={actions}>{body}</Frame>
}

function profileNeeds(summary: TransferFileSummary): Array<{ key: string; provider: AgentKind; label: string }> {
  return summary.profiles.filter((p) => !p.matched).map((p) => ({ key: `${p.provider}:${p.label}`, provider: p.provider, label: p.label }))
}

export interface ImportTarget {
  path: string
  name: string
}

export function ImportTransferDialog({ client, targets, profiles, initialWorkspace, initialFile, onImported, onClose }: {
  client: HoustonClient
  targets: ImportTarget[]
  profiles: AgentProfile[]
  initialWorkspace?: string
  initialFile?: string
  onImported: (result: TransferImportResult, workspace: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [file, setFile] = useState(initialFile ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [summary, setSummary] = useState<TransferFileSummary | null>(null)
  const [workspace, setWorkspace] = useState(initialWorkspace ?? targets[0]?.path ?? '')
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [outcome, setOutcome] = useState<Outcome<TransferImportResult | TransferFileSummary>>({ kind: 'idle' })
  const frame = useDialogFrame(onClose)
  const running = outcome.kind === 'running'
  const choose = async (): Promise<void> => {
    const picked = await pickTransferFile()
    if (picked) setFile(picked)
  }
  const inspect = async (): Promise<void> => {
    if (!file || !passphrase || running) return
    setOutcome({ kind: 'running', stage: 'decrypting' })
    const reply = await inspectTransfer(client, { path: file, passphrase })
    if (reply.kind === 'ok') {
      setSummary(reply.value)
      if (reply.value.proposed_workspace && targets.some((t) => t.path === reply.value.proposed_workspace)) setWorkspace(reply.value.proposed_workspace)
      setOutcome({ kind: 'idle' })
    } else {
      setOutcome(reply)
    }
  }
  const run = async (): Promise<void> => {
    if (!summary || !workspace || running) return
    const picks: TransferProfileChoice[] = profileNeeds(summary).map((need) => ({
      provider: need.provider,
      label: need.label,
      use_profile: (choices[need.key] ?? DEFAULT_ACCOUNT) || null
    }))
    setOutcome({ kind: 'running', stage: null })
    const reply = await importTransfer(client, { path: file, passphrase, workspace, profiles: picks }, (stage) => setOutcome({ kind: 'running', stage }))
    if (reply.kind === 'ok') {
      setPassphrase('')
      onImported(reply.value, workspace)
    }
    setOutcome(reply)
  }

  let body: React.ReactNode
  let actions: React.ReactNode
  if (outcome.kind === 'ok' && 'sessions' in outcome.value) {
    const result = outcome.value
    const resumed = result.sessions.length + result.updated_in_place.length
    body = <Stack gap={2}>
      <DialogDescription>Restored the code state and resumed {resumed === 1 ? '1 pane' : `${resumed} panes`} in <Text mono breakAll tone="primary">{result.workspace}</Text>.</DialogDescription>
      {result.updated_in_place.length > 0 && <Text as="p" size="small" tone="muted" flush>This file returned work that left this computer: its panes continued where they were.</Text>}
    </Stack>
    actions = <Button variant="primary" onClick={onClose}>Close</Button>
  } else if (outcome.kind === 'refused' || outcome.kind === 'error') {
    body = outcome.kind === 'refused' ? <TransferRefusalView refusal={outcome.refusal} /> : <Notice tone="danger" variant="callout">{outcome.message}</Notice>
    actions = <><Button variant="secondary" onClick={onClose}>Close</Button><span className="flex-1" /><Button variant="primary" onClick={() => setOutcome({ kind: 'idle' })}>Back</Button></>
  } else if (summary) {
    const needs = profileNeeds(summary)
    body = <Stack gap={3}>
      <DialogDescription>
        Exported from <Text mono breakAll tone="primary">{summary.source_workspace}</Text> on {OS_NAME[summary.source_os] ?? summary.source_os}, {new Date(summary.created_at_ms).toLocaleString()}.
        {summary.return_trip ? ' It continues work this computer exported; its panes resume in place.' : ''}
      </DialogDescription>
      <PaneList panes={summary.panes} skipped={summary.skipped} />
      <Text as="p" size="small" tone="muted" flush>Written by {summary.cli_versions.map((v) => `${providerName(v.provider)} ${v.version ?? '(version unknown)'}`).join(', ')}.</Text>
      <FormGrid>
        <FormGridLabel>Workspace</FormGridLabel>
        <Select aria-label="Workspace" width="full" value={workspace} options={targets.map((t) => ({ value: t.path, label: `${t.name} · ${t.path}` }))} onChange={setWorkspace} />
        {needs.map((need) => (
          <ProfileChoiceRow key={need.key} need={need} profiles={profiles} value={choices[need.key] ?? DEFAULT_ACCOUNT} onChange={(value) => setChoices((prev) => ({ ...prev, [need.key]: value }))} />
        ))}
      </FormGrid>
      {summary.proposed_workspace === null && <Text as="p" size="small" tone="muted" flush>No workspace here has the same git remote{summary.remote_url ? ` (${summary.remote_url})` : ''}; choose the checkout of the same project.</Text>}
      {running && <Progress stage={outcome.stage} />}
    </Stack>
    actions = <><Button variant="secondary" onClick={onClose} disabled={running}>Cancel</Button><span className="flex-1" /><Button variant="primary" disabled={running || !workspace} onClick={() => void run()}>Import</Button></>
  } else {
    body = <Stack gap={3}>
      <DialogDescription>Restores code and resumes the Claude and Codex panes from a transfer file.</DialogDescription>
      <FormGrid>
        <FormGridLabel htmlFor="transfer-file">File</FormGridLabel>
        <Inline gap="small">
          <TextInput variant="form" id="transfer-file" font="mono" readOnly value={file} placeholder="No file chosen" />
          <Button size="sm" onClick={() => void choose()}>Choose</Button>
        </Inline>
      </FormGrid>
      <PassphraseFields passphrase={passphrase} onPassphrase={setPassphrase} />
      {running && <Progress stage={outcome.stage} />}
    </Stack>
    actions = <><Button variant="secondary" onClick={onClose} disabled={running}>Cancel</Button><span className="flex-1" /><Button variant="primary" disabled={running || !file || !passphrase} onClick={() => void inspect()}>Continue</Button></>
  }
  return <Frame heading="Import transfer" onClose={onClose} frame={frame} actions={actions}>{body}</Frame>
}

function ProfileChoiceRow({ need, profiles, value, onChange }: { need: { provider: AgentKind; label: string }; profiles: AgentProfile[]; value: string; onChange: (value: string) => void }): React.JSX.Element {
  const options = [
    { value: DEFAULT_ACCOUNT, label: 'Default account' },
    ...profiles.filter((p) => p.agent === need.provider).map((p) => ({ value: p.name, label: p.name }))
  ]
  const label = `${providerName(need.provider)} profile ${need.label}`
  return <>
    <FormGridLabel>{label}</FormGridLabel>
    <Select aria-label={label} width="full" value={value} options={options} onChange={onChange} />
  </>
}

/** Opens the transfer dialogs from the workspace menu and from a transfer file the app
 *  was opened with. */
export function WorkspaceTransferHost({ client, workspaces, profiles, onImported }: { client: HoustonClient | null; workspaces: Workspace[]; profiles: AgentProfile[]; onImported: (result: TransferImportResult, workspace: string) => void }): React.JSX.Element | null {
  const [open, setOpen] = useState<TransferOpen | null>(null)
  const targets = workspaces.filter((w) => !wslWorkspaceOf(w.path))
  useEffect(() => {
    const show = (event: Event): void => setOpen((event as CustomEvent<TransferOpen>).detail)
    window.addEventListener(TRANSFER_EVENT, show)
    let stop: (() => void) | null = null
    let disposed = false
    void takeLaunchTransferFile().then((file) => { if (file && !disposed) setOpen({ mode: 'import', file }) })
    void listenTransferOpen((file) => setOpen({ mode: 'import', file })).then((unlisten) => {
      if (disposed) unlisten()
      else stop = unlisten
    })
    return () => {
      disposed = true
      window.removeEventListener(TRANSFER_EVENT, show)
      stop?.()
    }
  }, [])
  if (!open || !client) return null
  const close = (): void => setOpen(null)
  if (open.mode === 'export') return <ExportTransferDialog client={client} workspace={open.workspace} name={open.name} onClose={close} />
  const initialWorkspace = targets.some((t) => t.path === open.workspace) ? open.workspace : undefined
  return <ImportTransferDialog client={client} targets={targets} profiles={profiles} initialWorkspace={initialWorkspace} initialFile={open.file} onImported={onImported} onClose={close} />
}
