import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentMux, tagSession } from './environmentMux'
import { getEnvironmentRosterPending, subscribeEnvironmentRosterPending, type EnvironmentEntry } from './environments'
import { PROTOCOL_VERSION } from './generated/PROTOCOL_VERSION'

class Socket {
  readyState = 1
  binaryType = 'blob'
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  private closeListeners: Array<() => void> = []
  send(): void {}
  addEventListener(type: string, listener: () => void): void {
    if (type === 'close') this.closeListeners.push(listener)
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
    for (const listener of this.closeListeners) listener()
  }
  receive(msg: object): void { this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent) }
}
const entry: EnvironmentEntry = { id: 'wsl:Ubuntu', kind: 'wsl', distro: 'Ubuntu', slot: 0, state: 'ready', port: 5000, token: 'token' }
const hello = (sessions: unknown[] = [], workspaces: unknown[] = []) => ({
  type: 'hello_ok', protocol: PROTOCOL_VERSION, sessions, workspaces, tags: [],
  safe_mode: { disable_auto_restore: false, disable_swarm_autolaunch: false }, snapshot_attach: false, snapshot_format_version: 0
})
const session = () => ({
  id: 7, agent: 'shell', project_dir: '/home/test/project', cwd: '/home/test/project',
  state: 'running', title: 'retained WSL pane', codename: 'test', hidden: false,
  live_children: 0, children_waiting: 0, inbox_unread: 0, resumable: false, tags: []
})
const muxes: EnvironmentMux[] = []
function rig() {
  const local = new Socket()
  const remote = new Socket()
  const messages: Array<{ type: string; sessions?: Array<{ id: number }> }> = []
  const deliveryReadiness: Array<{ type: string; slots: number[]; workspaces: boolean }> = []
  local.onmessage = (event) => {
    const msg = JSON.parse(event.data as string)
    messages.push(msg)
    const pending = getEnvironmentRosterPending()
    deliveryReadiness.push({ type: msg.type, slots: [...pending.sessionSlots], workspaces: pending.workspaces })
  }
  const mux = new EnvironmentMux(local as unknown as WebSocket, () => remote as unknown as WebSocket)
  muxes.push(mux)
  return { local, remote, mux, messages, deliveryReadiness }
}
afterEach(() => {
  for (const mux of muxes.splice(0)) mux.dispose()
  vi.useRealTimers()
})

describe('environment roster readiness', () => {
  it('keeps first hello pending and clears each roster only after its merged delivery', () => {
    const r = rig()
    expect(getEnvironmentRosterPending().discovering).toBe(true)
    r.mux.setEnvironments([entry])
    r.local.receive(hello())
    expect([...getEnvironmentRosterPending().sessionSlots]).toEqual([0])
    expect(getEnvironmentRosterPending().workspaces).toBe(true)
    r.remote.receive(hello([session()], [{ path: '/home/test/project', name: 'WSL' }]))
    expect([...getEnvironmentRosterPending().sessionSlots]).toEqual([0])
    r.local.receive({ type: 'session_list', sessions: [] })
    expect(r.deliveryReadiness.at(-1)).toEqual({ type: 'session_list', slots: [0], workspaces: true })
    expect(r.messages.at(-1)?.sessions).toMatchObject([{ id: tagSession(0, 7) }])
    expect([...getEnvironmentRosterPending().sessionSlots]).toEqual([])
    expect(getEnvironmentRosterPending().workspaces).toBe(true)
    r.local.receive({ type: 'workspace_list', workspaces: [] })
    expect(r.deliveryReadiness.at(-1)?.workspaces).toBe(true)
    expect(getEnvironmentRosterPending().workspaces).toBe(false)
  })

  it('keeps an offline slot pending when a list timeout delivers its cached roster', () => {
    vi.useFakeTimers()
    const r = rig()
    r.mux.setEnvironments([entry])
    r.remote.receive(hello([session()]))
    r.local.receive({ type: 'session_list', sessions: [] })
    r.local.receive({ type: 'workspace_list', workspaces: [] })
    r.remote.close()
    expect([...getEnvironmentRosterPending().sessionSlots]).toEqual([0])
    ;(r.local as unknown as WebSocket).send(JSON.stringify({ type: 'session_list' }))
    vi.advanceTimersByTime(2000)
    expect(r.messages.filter((msg) => msg.type === 'session_list').at(-1)?.sessions).toMatchObject([{ id: tagSession(0, 7) }])
    expect([...getEnvironmentRosterPending().sessionSlots]).toEqual([0])
    expect(getEnvironmentRosterPending().workspaces).toBe(true)
  })

  it('does not replay a closed session from the cached roster after the WSL socket goes offline', () => {
    vi.useFakeTimers()
    const r = rig()
    r.mux.setEnvironments([entry])
    r.remote.receive(hello([session()]))
    r.local.receive({ type: 'session_list', sessions: [] })
    r.local.receive({ type: 'workspace_list', workspaces: [] })
    r.remote.receive({ type: 'session_removed', session: 7 })
    r.remote.close()
    r.local.receive({ type: 'session_list', sessions: [] })
    expect(r.messages.at(-1)?.sessions).toEqual([])
  })

  it('prunes disabled environments instead of leaving their slots pending indefinitely', () => {
    const r = rig()
    r.mux.setEnvironments([entry])
    r.local.receive(hello())
    r.mux.setEnvironments([])
    r.local.receive({ type: 'session_list', sessions: [] })
    r.local.receive({ type: 'workspace_list', workspaces: [] })
    expect([...getEnvironmentRosterPending().sessionSlots]).toEqual([])
    expect(getEnvironmentRosterPending().workspaces).toBe(false)
  })

  it('ignores old mux disposal after a new socket claims readiness and avoids duplicate notifications', () => {
    const previous = rig()
    previous.mux.setEnvironments([entry])
    const replacement = rig()
    replacement.mux.setEnvironments([])
    const pending = getEnvironmentRosterPending()
    const listener = vi.fn()
    const off = subscribeEnvironmentRosterPending(listener)
    previous.mux.dispose()
    replacement.mux.setEnvironments([])
    expect(getEnvironmentRosterPending()).toBe(pending)
    expect(listener).not.toHaveBeenCalled()
    off()
  })
})
