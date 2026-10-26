import { useEffect, useState } from 'react'
import type { HoustonClient } from '../houston/client'
import { wslWorkspaceOf } from '../houston/environments'
import type { AgentProfile } from '../houston/generated/AgentProfile'
import type { TransferImportResult } from '../houston/generated/TransferImportResult'
import type { Workspace } from '../houston/generated/Workspace'
import { listenTransferOpen, takeLaunchTransferFile, TRANSFER_EVENT, type TransferOpen } from '../houston/transferOpen'
import { preloadable } from '../preloadable'

// The dialogs load on first use; only the listeners are part of the boot bundle. A dialog
// opens only once its module has loaded: a Slot rendered before that would remount the
// dialog when the module arrives and discard what the user typed.
const exportDialog = preloadable(() => import('./WorkspaceTransferDialog').then((module) => module.ExportTransferDialog))
const importDialog = preloadable(() => import('./WorkspaceTransferDialog').then((module) => module.ImportTransferDialog))

/** Opens the transfer dialogs from the workspace menu and from a transfer file the app
 *  was opened with. */
export function WorkspaceTransferHost({ client, workspaces, agentProfiles, onImported }: { client: HoustonClient | null; workspaces: Workspace[]; agentProfiles: { profiles: AgentProfile[] } | null; onImported: (result: TransferImportResult, workspace: string) => void }): React.JSX.Element | null {
  const [open, setOpen] = useState<TransferOpen | null>(null)
  const targets = workspaces.filter((w) => !wslWorkspaceOf(w.path))
  useEffect(() => {
    let disposed = false
    const openLoaded = (detail: TransferOpen): void => {
      const dialog = detail.mode === 'export' ? exportDialog : importDialog
      dialog.preload().then(
        () => { if (!disposed) setOpen(detail) },
        (error: unknown) => console.error('houston: loading the workspace transfer dialog failed', error)
      )
    }
    const show = (event: Event): void => openLoaded((event as CustomEvent<TransferOpen>).detail)
    window.addEventListener(TRANSFER_EVENT, show)
    let stop: (() => void) | null = null
    void takeLaunchTransferFile().then((file) => { if (file && !disposed) openLoaded({ mode: 'import', file }) })
    void listenTransferOpen((file) => openLoaded({ mode: 'import', file })).then((unlisten) => {
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
  if (open.mode === 'export') return <exportDialog.Slot client={client} workspace={open.workspace} name={open.name} onClose={close} />
  const initialWorkspace = targets.some((t) => t.path === open.workspace) ? open.workspace : undefined
  return <importDialog.Slot client={client} targets={targets} profiles={agentProfiles?.profiles ?? []} initialWorkspace={initialWorkspace} initialFile={open.file} onImported={onImported} onClose={close} />
}
