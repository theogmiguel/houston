import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_ROUTES, EnvironmentMux, SERVER_ROUTES, tagSession } from './environmentMux'
import type { EnvironmentEntry } from './environments'
import { wslWorkspaces } from './environments'
import { encodeStdinFrame } from './client'

class FakeSocket {
  readyState = 1
  binaryType = 'blob'
  sent: Array<string | ArrayBuffer> = []
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  private closeListeners: Array<() => void> = []

  constructor(readonly url = 'ws://127.0.0.1:1/ws') {}

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({} as CloseEvent)
    for (const l of this.closeListeners) l()
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'close') this.closeListeners.push(listener)
  }

  receive(data: string | ArrayBuffer | object): void {
    const payload = typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data)
    this.onmessage?.({ data: payload } as MessageEvent)
  }

  json(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d))
  }

  frames(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => typeof d !== 'string')
  }
}

const LOCAL_ENTRY: EnvironmentEntry = { id: 'local', kind: 'local', slot: 0, port: 4000, token: 'local-token', state: 'ready' }

function wslEntry(distro: string, slot: number, port = 5000 + slot, token = `${distro}-token`): EnvironmentEntry {
  return { id: `wsl:${distro}`, kind: 'wsl', distro, slot, port, token, state: 'ready' }
}

function session(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, agent: 'shell', project_dir: '/home/u/p', cwd: '/home/u/p', state: 'running', title: 't', tags: [], ...over }
}

function hello(sessions: unknown[] = [], workspaces: unknown[] = []): Record<string, unknown> {
  return {
    type: 'hello_ok',
    protocol: 131,
    sessions,
    workspaces,
    tags: [],
    safe_mode: { active: false },
    snapshot_attach: true,
    snapshot_format_version: 1
  }
}

function outputFrame(session: number, payload: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(13 + payload.length)
  const view = new DataView(buf)
  view.setUint8(0, 1)
  view.setUint32(1, session, false)
  view.setUint32(9, 42, false)
  new Uint8Array(buf, 13).set(payload)
  return buf
}

function gapFrame(session: number): ArrayBuffer {
  const buf = new ArrayBuffer(21)
  const view = new DataView(buf)
  view.setUint8(0, 3)
  view.setUint32(1, session, false)
  view.setUint32(9, 100, false)
  view.setUint32(17, 5, false)
  return buf
}

function frameSession(buf: ArrayBuffer): number {
  return new DataView(buf).getUint32(1, false)
}

interface Rig {
  local: FakeSocket
  delivered: Array<string | ArrayBuffer>
  opened: FakeSocket[]
  mux: EnvironmentMux
  clientSend: (msg: object | ArrayBuffer) => void
  deliveredJson: () => Array<Record<string, unknown>>
}

function rig(): Rig {
  const local = new FakeSocket('ws://127.0.0.1:4000/ws')
  const delivered: Array<string | ArrayBuffer> = []
  local.onmessage = (ev) => delivered.push(ev.data as string | ArrayBuffer)
  const opened: FakeSocket[] = []
  const mux = new EnvironmentMux(local as unknown as WebSocket, (url) => {
    const s = new FakeSocket(url)
    opened.push(s)
    return s as unknown as WebSocket
  })
  return {
    local,
    delivered,
    opened,
    mux,
    clientSend: (msg) => {
      ;(local as unknown as WebSocket).send(msg instanceof ArrayBuffer ? msg : JSON.stringify(msg))
    },
    deliveredJson: () => delivered.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d))
  }
}

// Enables the given WSL distros, opens their sockets and answers their hello. The
// refresh lists the mux asks the local daemon for are answered with `localSessions`.
function connect(
  r: Rig,
  envs: Array<{ entry: EnvironmentEntry; sessions?: unknown[]; workspaces?: unknown[] }>,
  localSessions: unknown[] = [],
  localWorkspaces: unknown[] = []
): Map<string, FakeSocket> {
  r.mux.setEnvironments([LOCAL_ENTRY, ...envs.map((e) => e.entry)])
  const sockets = new Map<string, FakeSocket>()
  for (const { entry, sessions = [], workspaces = [] } of envs) {
    const socket = r.opened.find((s) => s.url === `ws://127.0.0.1:${entry.port}/ws`)!
    sockets.set(entry.distro!, socket)
    socket.onopen?.({} as Event)
    socket.receive(hello(sessions, workspaces))
  }
  r.local.receive({ type: 'session_list', sessions: localSessions })
  r.local.receive({ type: 'workspace_list', workspaces: localWorkspaces })
  for (const s of sockets.values()) s.sent.length = 0
  r.local.sent.length = 0
  r.delivered.length = 0
  return sockets
}

beforeEach(() => {
  wslWorkspaces.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('environmentMux', () => {
  it('passes through unchanged with only the local environment', () => {
    const r = rig()
    r.mux.setEnvironments([LOCAL_ENTRY])
    const out: object[] = [
      { type: 'hello', token: 'local-token', protocol: 131 },
      { type: 'session_list' },
      { type: 'workspace_list' },
      { type: 'session_kill', session: 7 },
      { type: 'git_status', dir: '/home/u/p', base: null },
      { type: 'workspace_add', path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\p' },
      { type: 'session_set_tags', session: 3, tags: [1] },
      { type: 'agent_hooks_set', provider: 'claude', enabled: true }
    ]
    for (const msg of out) r.clientSend(msg)
    expect(r.local.sent).toEqual(out.map((m) => JSON.stringify(m)))

    const stdin = encodeStdinFrame(0x81000007, new Uint8Array([104, 105]))
    const stdinCopy = stdin.slice(0)
    r.clientSend(stdin)
    expect(new Uint8Array(r.local.sent.at(-1) as ArrayBuffer)).toEqual(new Uint8Array(stdinCopy))

    const inbound: object[] = [
      hello([session(1)], [{ path: 'C:\\w', name: 'w' }]),
      { type: 'session_list', sessions: [session(1)] },
      { type: 'workspace_list', workspaces: [{ path: 'C:\\w', name: 'w' }] },
      { type: 'session_created', info: session(9, { tags: [2] }) },
      { type: 'session_tags_set', session: 9, tags: [2] }
    ]
    for (const msg of inbound) r.local.receive(msg)
    expect(r.delivered.map((d) => JSON.parse(d as string))).toEqual(inbound)
    const frame = outputFrame(7, [1, 2, 3])
    const gap = gapFrame(7)
    r.local.receive(frame)
    r.local.receive(gap)
    expect(new Uint8Array(r.delivered.at(-2) as ArrayBuffer)).toEqual(new Uint8Array(outputFrame(7, [1, 2, 3])))
    expect(new Uint8Array(r.delivered.at(-1) as ArrayBuffer)).toEqual(new Uint8Array(gapFrame(7)))
  })

  it('remaps session ids in json and frames', () => {
    const r = rig()
    const sockets = connect(r, [{ entry: wslEntry('Ubuntu', 1), workspaces: [{ path: '/home/u/p', name: 'p' }] }])
    const ubuntu = sockets.get('Ubuntu')!

    ubuntu.receive({ type: 'session_created', info: session(7) })
    ubuntu.receive({ type: 'session_created', info: session(8, { spawned_by: 7 }) })
    ubuntu.receive({ type: 'session_state', session: 7, state: 'exited', exit_code: 0 })
    ubuntu.receive(outputFrame(7, [65]))
    ubuntu.receive(gapFrame(7))

    const json = r.deliveredJson()
    expect((json[0].info as { id: number }).id).toBe(0x81000007)
    expect((json[1].info as { spawned_by: number }).spawned_by).toBe(0x81000007)
    expect(json[2].session).toBe(0x81000007)
    const frames = r.delivered.filter((d): d is ArrayBuffer => typeof d !== 'string')
    expect(frames.map(frameSession)).toEqual([0x81000007, 0x81000007])
    expect(new DataView(frames[0]).getUint8(0)).toBe(1)
    expect(new DataView(frames[1]).getUint8(0)).toBe(3)

    r.clientSend(encodeStdinFrame(0x81000007, new Uint8Array([120])))
    r.clientSend({ type: 'session_kill', session: 0x81000007 })
    expect(ubuntu.frames().map(frameSession)).toEqual([7])
    expect(new Uint8Array(ubuntu.frames()[0], 5)).toEqual(new Uint8Array([120]))
    expect(ubuntu.json()).toEqual([{ type: 'session_kill', session: 7 }])
    expect(r.local.sent).toEqual([])
  })

  it('drops session ids beyond the tag range', () => {
    const r = rig()
    const ubuntu = connect(r, [{ entry: wslEntry('Ubuntu', 1) }]).get('Ubuntu')!

    ubuntu.receive({ type: 'session_created', info: session(16777216) })

    const json = r.deliveredJson()
    expect(json.some((m) => m.type === 'session_created')).toBe(false)
    const errors = json.filter((m) => m.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('16777216')
    expect(errors[0].message).toContain('16777215')
  })

  it('classifies every generated message type', () => {
    const generated = (name: string): string[] => {
      const src = readFileSync(join(__dirname, 'generated', `${name}.ts`), 'utf8')
      return [...src.matchAll(/"type": "([a-z_]+)"/g)].map((m) => m[1]).sort()
    }
    expect(Object.keys(CLIENT_ROUTES).sort()).toEqual(generated('ClientMsg'))
    expect(Object.keys(SERVER_ROUTES).sort()).toEqual(generated('ServerMsg'))
  })

  it('routes session messages to the owning environment', () => {
    const r = rig()
    const sockets = connect(r, [{ entry: wslEntry('Ubuntu', 1) }, { entry: wslEntry('Debian', 2) }])
    const ubuntu = sockets.get('Ubuntu')!
    const debian = sockets.get('Debian')!
    const id = 0x81000005

    r.clientSend({ type: 'session_resize', session: id, cols: 80, rows: 24 })
    r.clientSend({ type: 'session_attach', session: id, replay_bytes: 100 })
    r.clientSend({ type: 'session_close', session: id })
    r.clientSend({ type: 'session_kill', session: id })

    expect(ubuntu.json()).toEqual([
      { type: 'session_resize', session: 5, cols: 80, rows: 24 },
      { type: 'session_attach', session: 5, replay_bytes: 100 },
      { type: 'session_close', session: 5 },
      { type: 'session_kill', session: 5 }
    ])
    expect(debian.sent).toEqual([])
    expect(r.local.sent).toEqual([])

    r.clientSend({ type: 'session_kill', session: 4 })
    expect(r.local.json()).toEqual([{ type: 'session_kill', session: 4 }])
    expect(ubuntu.json()).toHaveLength(4)
    expect(debian.sent).toEqual([])
  })

  it('routes path and global messages', () => {
    const r = rig()
    const sockets = connect(r, [
      { entry: wslEntry('Ubuntu', 1), workspaces: [{ path: '/home/u/p', name: 'p' }] },
      { entry: wslEntry('Debian', 2), workspaces: [{ path: '/srv/d', name: 'd' }] }
    ])
    const ubuntu = sockets.get('Ubuntu')!
    const debian = sockets.get('Debian')!

    r.clientSend({ type: 'git_status', dir: '/home/u/p', base: null })
    expect(ubuntu.json()).toEqual([{ type: 'git_status', dir: '/home/u/p', base: null }])
    expect(debian.sent).toEqual([])
    expect(r.local.sent).toEqual([])

    r.clientSend({ type: 'git_status', dir: 'C:\\w', base: null })
    r.clientSend({ type: 'keymap_get' })
    expect(r.local.json()).toEqual([{ type: 'git_status', dir: 'C:\\w', base: null }, { type: 'keymap_get' }])
    expect(ubuntu.json()).toHaveLength(1)
    expect(debian.sent).toEqual([])
  })

  it('refuses a posix path owned by another environment', () => {
    const r = rig()
    const sockets = connect(r, [
      { entry: wslEntry('Ubuntu', 1) },
      { entry: wslEntry('Debian', 2), workspaces: [{ path: '/home/u/p', name: 'p' }] }
    ])

    r.clientSend({ type: 'workspace_add', path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\p' })

    expect(sockets.get('Ubuntu')!.sent).toEqual([])
    expect(sockets.get('Debian')!.sent).toEqual([])
    expect(r.local.sent).toEqual([])
    const errors = r.deliveredJson().filter((m) => m.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('/home/u/p')
    expect(errors[0].message).toContain('WSL: Debian')
  })

  it('adds a picked wsl folder to its distro as a posix path', () => {
    const r = rig()
    const ubuntu = connect(r, [{ entry: wslEntry('Ubuntu', 1) }]).get('Ubuntu')!

    r.clientSend({ type: 'workspace_add', path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\p' })

    expect(ubuntu.json()).toEqual([{ type: 'workspace_add', path: '/home/u/p' }])
    expect(r.local.sent).toEqual([])
  })

  it('merges list replies across environments', () => {
    const r = rig()
    r.mux.setEnvironments([LOCAL_ENTRY, wslEntry('Ubuntu', 1)])
    const ubuntu = r.opened[0]
    ubuntu.onopen?.({} as Event)
    ubuntu.receive(hello([session(3)], [{ path: '/home/u/p', name: 'p' }]))
    r.local.receive(hello([session(1, { project_dir: 'C:\\w' })], [{ path: 'C:\\w', name: 'w' }]))

    const helloOk = r.deliveredJson().find((m) => m.type === 'hello_ok')!
    expect((helloOk.sessions as Array<{ id: number }>).map((s) => s.id)).toEqual([1, 0x81000003])
    expect((helloOk.workspaces as Array<{ path: string }>).map((w) => w.path)).toEqual(['C:\\w', '/home/u/p'])

    r.local.receive({ type: 'session_list', sessions: [session(1)] })
    r.local.receive({ type: 'workspace_list', workspaces: [{ path: 'C:\\w', name: 'w' }] })
    r.delivered.length = 0
    r.local.sent.length = 0
    ubuntu.sent.length = 0

    r.clientSend({ type: 'session_list' })
    r.clientSend({ type: 'workspace_list' })
    expect(r.local.json()).toEqual([{ type: 'session_list' }, { type: 'workspace_list' }])
    expect(ubuntu.json()).toEqual([{ type: 'session_list' }, { type: 'workspace_list' }])
    r.local.receive({ type: 'session_list', sessions: [session(1)] })
    ubuntu.receive({ type: 'session_list', sessions: [session(3)] })
    ubuntu.receive({ type: 'workspace_list', workspaces: [{ path: '/home/u/p', name: 'p' }] })
    r.local.receive({ type: 'workspace_list', workspaces: [{ path: 'C:\\w', name: 'w' }] })

    const replies = r.deliveredJson()
    expect(replies.map((m) => m.type)).toEqual(['session_list', 'workspace_list'])
    expect((replies[0].sessions as Array<{ id: number }>).map((s) => s.id)).toEqual([1, 0x81000003])
    expect((replies[1].workspaces as Array<{ path: string }>).map((w) => w.path)).toEqual(['C:\\w', '/home/u/p'])
  })

  it('strips wsl tags and refuses tagging', () => {
    const r = rig()
    const ubuntu = connect(r, [{ entry: wslEntry('Ubuntu', 1) }]).get('Ubuntu')!

    ubuntu.receive({ type: 'session_updated', info: session(7, { tags: [2] }) })
    expect((r.deliveredJson()[0].info as { tags: number[] }).tags).toEqual([])

    r.clientSend({ type: 'session_set_tags', session: 0x81000007, tags: [2] })
    expect(ubuntu.sent).toEqual([])
    expect(r.local.sent).toEqual([])
    const error = r.deliveredJson().find((m) => m.type === 'error')!
    expect(error.message).toContain(String(0x81000007))
  })

  it('broadcasts hook and orchestration settings', () => {
    const r = rig()
    const sockets = connect(r, [{ entry: wslEntry('Ubuntu', 1) }, { entry: wslEntry('Debian', 2) }])
    const hooks = { type: 'agent_hooks_set', provider: 'claude', enabled: false }
    const orchestration = { type: 'orchestration_set', enabled: true }

    r.clientSend(hooks)
    r.clientSend(orchestration)

    for (const socket of [r.local, sockets.get('Ubuntu')!, sockets.get('Debian')!]) {
      expect(socket.json()).toEqual([hooks, orchestration])
    }
  })

  it('keeps local traffic while a wsl environment reconnects', () => {
    vi.useFakeTimers()
    const r = rig()
    const entry = wslEntry('Ubuntu', 1)
    const ubuntu = connect(r, [{ entry }]).get('Ubuntu')!

    ubuntu.close()
    const frame = outputFrame(4, [9, 9])
    r.local.receive(frame)
    r.clientSend({ type: 'session_resize', session: 4, cols: 100, rows: 30 })
    expect(r.delivered).toEqual([frame])
    expect(frameSession(r.delivered[0] as ArrayBuffer)).toBe(4)
    expect(r.local.json()).toEqual([{ type: 'session_resize', session: 4, cols: 100, rows: 30 }])

    vi.advanceTimersByTime(999)
    expect(r.opened).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(r.opened).toHaveLength(2)
    const again = r.opened[1]
    expect(again.url).toBe(`ws://127.0.0.1:${entry.port}/ws`)
    again.onopen?.({} as Event)
    expect(again.json()).toEqual([{ type: 'hello', token: entry.token, protocol: 131 }])
    expect(r.local.json().some((m) => m.type === 'hello')).toBe(false)
  })

  it('answers a pane that attached while its environment was down once it is back', () => {
    const r = rig()
    const entry = wslEntry('Ubuntu', 1)
    const ended = session(4, { state: 'killed' })
    const first = connect(r, [{ entry, sessions: [ended] }]).get('Ubuntu')!
    const tagged = tagSession(1, 4)
    const scrollback = (attempt: number) => ({
      type: 'scrollback', session: 4, data: 'aGk=', generation: 1, replayed_bytes: 2, bytes_seen: 2, attempt
    })

    r.clientSend({ type: 'session_attach', session: tagged, replay_bytes: 1024 })
    first.receive(scrollback(1))
    const attempts = () => r.deliveredJson().filter((m) => m.type === 'scrollback').map((m) => [m.session, m.attempt])
    expect(attempts()).toEqual([[tagged, 1]])

    r.mux.setEnvironments([LOCAL_ENTRY])
    r.clientSend({ type: 'session_attach', session: tagged, replay_bytes: 1024 })
    r.mux.setEnvironments([LOCAL_ENTRY, entry])
    const second = r.opened.at(-1)!
    expect(second).not.toBe(first)
    second.onopen?.({} as Event)
    second.receive(hello([ended]))

    expect(second.json().filter((m) => m.type === 'session_attach')).toEqual([
      { type: 'session_attach', session: 4, replay_bytes: 1024 }
    ])
    second.receive(scrollback(1))
    expect(attempts()).toEqual([[tagged, 1], [tagged, 2]])
  })

  it('drops a disabled environment and its workspaces from the merged view', () => {
    const r = rig()
    connect(r, [{ entry: wslEntry('Ubuntu', 1), sessions: [session(3)], workspaces: [{ path: '/home/u/p', name: 'p' }] }])
    expect(wslWorkspaces.get('/home/u/p')).toBe('Ubuntu')

    r.mux.setEnvironments([LOCAL_ENTRY])
    r.local.receive({ type: 'session_list', sessions: [session(1)] })
    r.local.receive({ type: 'workspace_list', workspaces: [] })

    const json = r.deliveredJson()
    const sessions = json.filter((m) => m.type === 'session_list').at(-1)!
    expect((sessions.sessions as Array<{ id: number }>).map((s) => s.id)).toEqual([1])
    expect(wslWorkspaces.size).toBe(0)
  })

  it('delivers a focus after the merged workspace list that holds it', () => {
    const r = rig()
    const ubuntu = connect(r, [{ entry: wslEntry('Ubuntu', 1) }]).get('Ubuntu')!

    ubuntu.receive({ type: 'workspace_list', workspaces: [{ path: '/home/u/q', name: 'q' }] })
    ubuntu.receive({ type: 'workspace_focus', path: '/home/u/q' })
    expect(r.delivered).toEqual([])
    r.local.receive({ type: 'workspace_list', workspaces: [] })

    expect(r.deliveredJson().map((m) => m.type)).toEqual(['workspace_list', 'workspace_focus'])
  })
})
