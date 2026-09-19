import { useEffect, useState } from 'react'
import { isTauri } from './host'

const REQUEST_EVENT = 'browser://confirm-request'
const RESOLVED_EVENT = 'browser://confirm-resolved'

export type ActKind = 'click' | 'type' | 'hover' | 'pressKey' | 'selectOption'

export interface ConfirmElement {
  ref: string
  role: string
  tag: string
  name: string
  value?: string
  href?: string
  rect: { x: number; y: number; width: number; height: number }
  state?: Record<string, boolean>
}

export interface ConfirmRequest {
  id: string
  surfaceId: string
  workspaceId: string
  kind: ActKind
  element: ConfirmElement
  text: string | null
  replace: boolean
  hasScreenshot: boolean
  url: string | null
  title: string | null
  timeoutSecs: number
}

let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null
function eventApiModule(): Promise<typeof import('@tauri-apps/api/event')> {
  eventApi ??= import('@tauri-apps/api/event').catch((err: unknown) => {
    eventApi = null
    throw err
  })
  return eventApi
}

async function invoker(): Promise<
  <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

export function useBrowserConfirm(): ConfirmRequest | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    const disposers: Array<() => void> = []

    void (async () => {
      const { listen } = await eventApiModule()
      const offRequest = await listen<ConfirmRequest>(REQUEST_EVENT, (event) => {
        setRequest(event.payload)
      })
      const offResolved = await listen<{ id: string }>(RESOLVED_EVENT, (event) => {
        setRequest((cur) => (cur && cur.id === event.payload.id ? null : cur))
      })
      const callable = [offRequest, offResolved].filter(
        (off): off is () => void => typeof off === 'function'
      )
      if (disposed) {
        for (const off of callable) off()
        return
      }
      disposers.push(...callable)
    })().catch((err: unknown) => {
      console.error(`[browser] ${REQUEST_EVENT} subscribe failed:`, err)
    })

    return () => {
      disposed = true
      for (const off of disposers) off()
    }
  }, [])

  return request
}

export async function respondToAct(
  request: ConfirmRequest,
  approved: boolean,
  trustWorkspace = false
): Promise<void> {
  const invoke = await invoker()
  await invoke<void>('browser_confirm_respond', {
    id: request.id,
    approved,
    trustWorkspace,
    workspaceId: request.workspaceId
  })
}

export async function fetchActScreenshot(request: ConfirmRequest): Promise<string | null> {
  if (!request.hasScreenshot) return null
  try {
    const invoke = await invoker()
    const bytes = await invoke<ArrayBuffer>('browser_confirm_screenshot', { id: request.id })
    return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
  } catch (err) {
    console.error(`[browser] confirmation capture unavailable for ${request.id}:`, err)
    return null
  }
}

export async function trustedWorkspaces(): Promise<string[]> {
  const invoke = await invoker()
  return invoke<string[]>('browser_confirm_trusted')
}

export async function revokeWorkspaceTrust(workspaceId: string): Promise<boolean> {
  const invoke = await invoker()
  return invoke<boolean>('browser_confirm_revoke_trust', { workspaceId })
}
