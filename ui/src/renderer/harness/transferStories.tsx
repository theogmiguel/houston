import React from 'react'
import { ExportTransferDialog, ImportTransferDialog, TransferRefusalView } from '../src/components/WorkspaceTransferDialog'
import { WorkspaceContextMenu } from '../src/components/rail/RailContextMenus'
import { DialogBackdrop, DialogBody, DialogPanel, DialogTitle } from '../src/components/ui'
import type { HoustonClient } from '../src/houston/client'
import type { ClientMsg } from '../src/houston/generated/ClientMsg'
import type { ServerMsg } from '../src/houston/generated/ServerMsg'
import type { TransferFileSummary } from '../src/houston/generated/TransferFileSummary'

const noop = (): void => {}

const SUMMARY: TransferFileSummary = {
  transfer_id: 'story',
  source_os: 'linux',
  source_workspace: '/home/dev/acme',
  remote_url: 'git@github.com:acme/acme.git',
  created_at_ms: Date.UTC(2026, 9, 21, 18, 40),
  panes: [
    { session: 4, title: 'api review', provider: 'claude', checkout: 'main checkout', profile_label: 'work' },
    { session: 7, title: 'login fix', provider: 'codex', checkout: 'worktree fix-login', profile_label: null }
  ],
  skipped: [
    { session: 5, title: 'zsh', reason: 'shell pane' },
    { session: 9, title: 'tests', reason: 'orchestrated child; parent and child panes do not transfer in this version' }
  ],
  cli_versions: [{ provider: 'claude', version: '2.1.307' }, { provider: 'codex', version: '0.142.3' }],
  proposed_workspace: '/home/dev/acme',
  profiles: [{ provider: 'claude', label: 'work', matched: false }],
  return_trip: false
}

/** Answers `transfer_inspect` with `SUMMARY`, so the import dialog reaches its review step. */
function transferClient(): HoustonClient {
  const handlers = new Set<(message: ServerMsg) => void>()
  const client = {
    subscribeAll: (handler: (message: ServerMsg) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    send: (message: ClientMsg) => {
      if (message.type !== 'transfer_inspect') return
      setTimeout(() => { for (const handler of [...handlers]) handler({ type: 'transfer_inspected', request: message.request, summary: SUMMARY }) }, 0)
    }
  }
  return client as unknown as HoustonClient
}

function typeInto(input: HTMLInputElement | null, value: string): void {
  if (!input) return
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export function TransferExportStory(): React.JSX.Element {
  const client = React.useMemo(transferClient, [])
  React.useEffect(() => {
    typeInto(document.querySelector('#transfer-passphrase'), 'correct horse battery staple')
    typeInto(document.querySelector('#transfer-passphrase-confirm'), 'correct horse battery staple')
  }, [])
  return <ExportTransferDialog client={client} workspace="/home/dev/acme" name="acme" onClose={noop} />
}

export function TransferImportStory(): React.JSX.Element {
  const client = React.useMemo(transferClient, [])
  React.useEffect(() => {
    typeInto(document.querySelector('#transfer-passphrase'), 'correct horse battery staple')
    setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="workspace-transfer"] button')].find((b) => b.textContent === 'Continue')?.click(), 0)
  }, [])
  const targets = [{ path: '/home/dev/acme', name: 'acme' }, { path: '/home/dev/scratch', name: 'scratch' }]
  return <ImportTransferDialog client={client} targets={targets} profiles={[]} initialFile="/home/dev/Downloads/acme-2026-10-21.houston-transfer" onImported={noop} onClose={noop} />
}

export function TransferRefusalStory(): React.JSX.Element {
  return (
    <DialogBackdrop>
      <DialogPanel size="wide" role="dialog" aria-modal="true" aria-labelledby="refusal-title">
        <DialogTitle id="refusal-title">Import transfer</DialogTitle>
        <DialogBody variant="bounded">
          <TransferRefusalView refusal={{
            code: 'dirty_checkout',
            problem: '/home/dev/acme has uncommitted changes, and import would mix them with the transferred changes.',
            items: ['README.md', 'src/lib.rs', 'notes/todo.txt'],
            steps: ['Commit, stash or discard the listed changes in /home/dev/acme, then import again.', 'Or choose another folder for the import.']
          }} />
        </DialogBody>
      </DialogPanel>
    </DialogBackdrop>
  )
}

export function WorkspaceMenuStory(): React.JSX.Element {
  return <WorkspaceContextMenu
    menu={{ x: 40, y: 40, path: '/home/dev/acme', name: 'acme', color: '#7aa2f7', pinned: false, selected: true }}
    onClose={noop}
    onAddGrid={noop}
    onRenameStart={noop}
    onRemoveWorkspace={noop}
    onTogglePin={noop}
  />
}
