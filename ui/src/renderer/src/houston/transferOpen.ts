import { isTauri } from './host'

/** Opens the workspace transfer dialog; `detail` is a `TransferOpen`. */
export const TRANSFER_EVENT = 'houston:workspace-transfer'

export type TransferOpen =
  | { mode: 'export'; workspace: string; name: string }
  | { mode: 'import'; workspace?: string; file?: string }

export function openWorkspaceTransfer(detail: TransferOpen): void {
  window.dispatchEvent(new CustomEvent<TransferOpen>(TRANSFER_EVENT, { detail }))
}

/** A transfer file the app was opened with, once; later ones arrive as `transfer-open` events. */
export async function takeLaunchTransferFile(): Promise<string | null> {
  if (!isTauri()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string | null>('transfer_launch_file')
}

export async function listenTransferOpen(handler: (path: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<string>('transfer-open', (event) => handler(event.payload))
}
