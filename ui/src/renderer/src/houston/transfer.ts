import type { HoustonClient } from './client'
import type { ClientMsg } from './generated/ClientMsg'
import type { ServerMsg } from './generated/ServerMsg'
import type { TransferExportSummary } from './generated/TransferExportSummary'
import type { TransferFileSummary } from './generated/TransferFileSummary'
import type { TransferImportResult } from './generated/TransferImportResult'
import type { TransferProfileChoice } from './generated/TransferProfileChoice'
import type { TransferRefusal } from './generated/TransferRefusal'
import type { TransferStage } from './generated/TransferStage'
import { isTauri } from './host'

/** The extension Houston writes and registers for workspace transfer files. */
export const TRANSFER_EXTENSION = 'houston-transfer'

export type TransferReply<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'refused'; refusal: TransferRefusal }
  | { kind: 'error'; message: string }

let nextRequest = 1

const CONNECTION_LOST =
  'The connection to Houston was lost. The transfer may have completed or been undone; check the workspace before trying again.'

/** Sends one transfer request and settles on its reply. Progress arrives through `onStage`;
 *  the daemon answers every request, so there is no client timeout. A closed connection
 *  settles it too: the daemon may still have carried the transfer out. */
function request<T>(
  client: HoustonClient,
  build: (request: number) => ClientMsg,
  pick: (msg: ServerMsg) => T | undefined,
  onStage?: (stage: TransferStage) => void
): Promise<TransferReply<T>> {
  const id = nextRequest++
  return new Promise((resolve) => {
    const previousOnClose = client.onClose
    let unsubscribe = () => {}
    let settled = false
    const settle = (reply: TransferReply<T>): void => {
      if (settled) return
      settled = true
      unsubscribe()
      if (client.onClose === onClose) client.onClose = previousOnClose
      resolve(reply)
    }
    const onClose = (): void => {
      previousOnClose()
      settle({ kind: 'error', message: CONNECTION_LOST })
    }
    unsubscribe = client.subscribeAll((msg) => {
      if (msg.type === 'transfer_progress' && msg.request === id) {
        onStage?.(msg.stage)
        return
      }
      if (msg.type === 'transfer_refused' && msg.request === id) {
        settle({ kind: 'refused', refusal: msg.refusal })
        return
      }
      if (msg.type === 'error' && msg.context === `transfer:${id}`) {
        settle({ kind: 'error', message: msg.message })
        return
      }
      const value = 'request' in msg && msg.request === id ? pick(msg) : undefined
      if (value !== undefined) settle({ kind: 'ok', value })
    })
    client.onClose = onClose
    client.send(build(id))
  })
}

export function exportTransfer(
  client: HoustonClient,
  args: { workspace: string; destination: string; overwrite: boolean; passphrase: string; grids: string },
  onStage?: (stage: TransferStage) => void
): Promise<TransferReply<TransferExportSummary>> {
  return request(
    client,
    (id) => ({ type: 'transfer_export', request: id, ...args }),
    (msg) => (msg.type === 'transfer_exported' ? msg.summary : undefined),
    onStage
  )
}

export function inspectTransfer(
  client: HoustonClient,
  args: { path: string; passphrase: string }
): Promise<TransferReply<TransferFileSummary>> {
  return request(
    client,
    (id) => ({ type: 'transfer_inspect', request: id, ...args }),
    (msg) => (msg.type === 'transfer_inspected' ? msg.summary : undefined)
  )
}

export function importTransfer(
  client: HoustonClient,
  args: { path: string; passphrase: string; workspace: string; profiles: TransferProfileChoice[] },
  onStage?: (stage: TransferStage) => void
): Promise<TransferReply<TransferImportResult>> {
  return request(
    client,
    (id) => ({ type: 'transfer_import', request: id, ...args }),
    (msg) => (msg.type === 'transfer_imported' ? msg.result : undefined),
    onStage
  )
}

export const TRANSFER_STAGE_LABEL: Record<TransferStage, string> = {
  checking: 'Checking panes and code',
  packing: 'Packing and encrypting',
  decrypting: 'Decrypting',
  restoring_code: 'Restoring code',
  placing_conversations: 'Placing conversations',
  starting_panes: 'Resuming panes'
}

/** The default file name for an export: the workspace and today's date. */
export function transferFileName(workspaceName: string, now: Date = new Date()): string {
  const slug = workspaceName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  const date = now.toISOString().slice(0, 10)
  return `${slug}-${date}.${TRANSFER_EXTENSION}`
}

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/** `path` ending in the transfer extension. A save dialog does not always add it. */
export function withTransferExtension(path: string): string {
  return path.toLowerCase().endsWith(`.${TRANSFER_EXTENSION}`) ? path : `${path}.${TRANSFER_EXTENSION}`
}

/** Where to save an export, as the save dialog confirmed it, or null when cancelled or
 *  outside the desktop app. */
export async function pickTransferDestination(defaultName: string): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('dialog_save_transfer', { defaultName })
}

export async function pickTransferFile(): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('dialog_pick_transfer')
}
