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

/** Sends one transfer request and settles on its reply. Progress arrives through `onStage`;
 *  the daemon answers every request, so there is no client timeout. */
function request<T>(
  client: HoustonClient,
  build: (request: number) => ClientMsg,
  pick: (msg: ServerMsg) => T | undefined,
  onStage?: (stage: TransferStage) => void
): Promise<TransferReply<T>> {
  const id = nextRequest++
  return new Promise((resolve) => {
    const unsubscribe = client.subscribeAll((msg) => {
      if (msg.type === 'transfer_progress' && msg.request === id) {
        onStage?.(msg.stage)
        return
      }
      if (msg.type === 'transfer_refused' && msg.request === id) {
        unsubscribe()
        resolve({ kind: 'refused', refusal: msg.refusal })
        return
      }
      if (msg.type === 'error' && msg.context === `transfer:${id}`) {
        unsubscribe()
        resolve({ kind: 'error', message: msg.message })
        return
      }
      const value = 'request' in msg && msg.request === id ? pick(msg) : undefined
      if (value !== undefined) {
        unsubscribe()
        resolve({ kind: 'ok', value })
      }
    })
    client.send(build(id))
  })
}

export function exportTransfer(
  client: HoustonClient,
  args: { workspace: string; destination: string; passphrase: string; grids: string },
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

/** Where to save an export, or null when cancelled or outside the desktop app. */
export async function pickTransferDestination(defaultName: string): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('dialog_save_transfer', { defaultName })
}

export async function pickTransferFile(): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('dialog_pick_transfer')
}
