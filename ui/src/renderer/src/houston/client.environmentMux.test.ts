// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoustonClient } from './client'
import { EnvironmentMux, tagSession } from './environmentMux'
import { wslWorkspaces, type EnvironmentEntry } from './environments'
import { PROTOCOL_VERSION } from './generated/PROTOCOL_VERSION'
import { MAX_SOCKET_INPUT_BYTES, REPLY_RESERVE_BYTES } from './transport/ws'

class FakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = 0
  bufferedAmount = 0
  binaryType = ''
  sent: Array<string | ArrayBuffer> = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  private closeListeners: Array<() => void> = []

  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN
      this.onopen?.()
    })
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  receive(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'close') this.closeListeners.push(listener)
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
    for (const listener of this.closeListeners) listener()
  }

  frames(): ArrayBuffer[] {
    return this.sent.filter((data): data is ArrayBuffer => data instanceof ArrayBuffer)
  }
}

const ENTRY: EnvironmentEntry = {
  id: 'wsl:Ubuntu', kind: 'wsl', distro: 'Ubuntu', slot: 1,
  port: 5001, token: 'wsl-token', state: 'ready'
}

function hello(sessions: unknown[] = []): object {
  return { type: 'hello_ok', protocol: PROTOCOL_VERSION, sessions, workspaces: [], tags: [] }
}

function frameData(frame: ArrayBuffer): [number, string] {
  return [new DataView(frame).getUint32(1, false), new TextDecoder().decode(new Uint8Array(frame, 5))]
}

async function rig() {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('houston', {
    getConfig: async () => ({ port: 4000, token: 'local-token', pid: 0, protocol: PROTOCOL_VERSION })
  })
  const client = await HoustonClient.connect()
  const local = (client as unknown as { ws: FakeSocket }).ws
  const opened: FakeSocket[] = []
  const mux = new EnvironmentMux(local as unknown as WebSocket, (url) => {
    const socket = new FakeSocket(url)
    opened.push(socket)
    return socket as unknown as WebSocket
  })
  mux.setEnvironments([ENTRY])
  await Promise.resolve()
  const wsl = opened[0]
  wsl.receive(hello([{ id: 7, agent: 'shell', state: 'running', project_dir: '/project', cwd: '/project' }]))
  local.receive(hello())
  wsl.sent.length = 0
  local.sent.length = 0
  const errors: string[] = []
  client.subscribe('error', (message) => errors.push(message.message))
  return { client, local, wsl, mux, opened, errors }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  wslWorkspaces.clear()
})

describe('HoustonClient WSL input admission', () => {
  it('refuses disconnected input and input before reconnect hello without replaying it', async () => {
    const { client, local, wsl, opened, errors } = await rig()
    try {
      const session = tagSession(1, 7)
      expect(client.sendStdin(session, 'before')).toBe(true)
      expect(wsl.frames().map(frameData)).toEqual([[7, 'before']])
      wsl.close()
      expect(local.readyState).toBe(FakeSocket.OPEN)
      expect(client.sendStdin(session, 'lost')).toBe(false)
      expect(client.sendStdin(session, '\x1b[1;1R', true)).toBe(false)
      expect(errors).toHaveLength(2)
      expect(errors[0]).toContain(`Input refused for session ${session}: WSL: Ubuntu`)
      expect(client.sendStdin(4, 'local')).toBe(true)
      expect(local.frames().map(frameData)).toEqual([[4, 'local']])
      await vi.advanceTimersByTimeAsync(1000)
      const again = opened[1]
      expect(again.readyState).toBe(FakeSocket.OPEN)
      expect(client.sendStdin(session, 'before-hello')).toBe(false)
      expect(errors.at(-1)).toContain('hello_ok false')
      again.receive(hello([{ id: 7, agent: 'shell', state: 'running' }]))
      expect(again.frames()).toEqual([])
      expect(client.sendStdin(session, 'after')).toBe(true)
      expect(again.frames().map(frameData)).toEqual([[7, 'after']])
      expect(wsl.frames().map(frameData)).toEqual([[7, 'before']])
    } finally { client.close() }
  })

  it('uses each destination backlog and retains the terminal reply reserve', async () => {
    const { client, local, wsl, errors } = await rig()
    try {
      const session = tagSession(1, 7)
      local.bufferedAmount = MAX_SOCKET_INPUT_BYTES
      expect(client.sendStdin(session, '\x1b[200~é🙂\x1b[201~')).toBe(true)
      expect(client.sendStdin(4, 'local')).toBe(false)
      expect(local.frames()).toEqual([])
      local.bufferedAmount = 0
      wsl.bufferedAmount = MAX_SOCKET_INPUT_BYTES
      expect(client.sendStdin(session, 'paste')).toBe(false)
      expect(errors.at(-1)).toContain(`current socket backlog ${MAX_SOCKET_INPUT_BYTES}`)
      expect(wsl.frames()).toHaveLength(1)
      expect(client.sendStdin(4, 'local')).toBe(true)
      expect(client.sendStdin(session, '\x1b[1;1R', true)).toBe(true)
      wsl.bufferedAmount += REPLY_RESERVE_BYTES
      expect(client.sendStdin(session, '\x1b[1;1R', true)).toBe(false)
      expect(wsl.frames().map(frameData)).toEqual([[7, '\x1b[200~é🙂\x1b[201~'], [7, '\x1b[1;1R']])
      expect(local.frames().map(frameData)).toEqual([[4, 'local']])
    } finally { client.close() }
  })

  it('refuses unavailable environment slots without forwarding their input to native', async () => {
    const { client, local, mux, errors } = await rig()
    try {
      mux.setEnvironments([{ ...ENTRY, state: 'starting' }])
      expect(client.sendStdin(tagSession(1, 7), 'starting')).toBe(false)
      expect(errors.at(-1)).toContain('environment starting')
      mux.setEnvironments([])
      expect(client.sendStdin(tagSession(1, 7), 'disabled')).toBe(false)
      expect(client.sendStdin(tagSession(2, 7), 'missing')).toBe(false)
      expect(errors.at(-1)).toContain('no enabled WSL environment owns slot 2')
      expect(local.frames()).toEqual([])
      expect(client.sendStdin(4, 'native')).toBe(true)
      expect(local.frames().map(frameData)).toEqual([[4, 'native']])
    } finally { client.close() }
  })
})
