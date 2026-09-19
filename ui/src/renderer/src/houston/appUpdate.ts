// The renderer's only door into signed click-to-update. It speaks the narrow
// `app_update_install` command and its progress events, so the updater plugin's
// own JS stays unreachable and nothing downloads without an explicit click.
import { isTauri } from './host'
import type { UpdateChannel } from './generated/UpdateChannel'

/** Mirrors `AppUpdateOutcome` in src-tauri/src/app_update.rs. */
export type AppUpdateOutcome =
  | { kind: 'up_to_date'; version: string }
  | { kind: 'installed'; version: string }

/** Mirrors the `app-update://progress` payload from src-tauri/src/app_update.rs. */
export interface AppUpdateProgress {
  phase: 'downloading' | 'installing'
  downloaded: number
  total: number | null
}

export const APP_UPDATE_PROGRESS_EVENT = 'app-update://progress'

export async function appUpdateInstall(
  channel: UpdateChannel,
  expectedVersion: string
): Promise<AppUpdateOutcome> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<AppUpdateOutcome>('app_update_install', { channel, expectedVersion })
}

export async function onAppUpdateProgress(
  handler: (progress: AppUpdateProgress) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen<AppUpdateProgress>(APP_UPDATE_PROGRESS_EVENT, (e) => handler(e.payload))
  } catch (err) {
    console.warn(`houston: could not subscribe to ${APP_UPDATE_PROGRESS_EVENT}`, err)
    return () => {}
  }
}
