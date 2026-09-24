import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { resetPaneNoticeRingsForTests } from '../components/SessionPane'
import { setRailViewForTests } from '../railView'
import { resetRailWidthForTests } from '../railWidth'
import { resetScmWidthForTests } from '../scmPanel'
import { resetNotificationStoreForTests } from '../notificationStore'
import type { HoustonClient as HoustonClientType, SessionInfo, Workspace } from '../houston/client'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import type { SwarmInfo } from '../houston/generated/SwarmInfo'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from './ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

let mockWidth = 400
let mockHeight = 300
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => mockWidth
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => mockHeight
})

let wiredHandler: ((msg: ServerMsg) => void) | null = null

// Per-client `client.subscribe(kind, handler)` registrations, so a test can
// feed one pane's own subscription (git status, pr status) without touching App.
let kindHandlers: Map<string, Set<(msg: never) => void>> = new Map()

// The roster's cwds, so the fake client answers `sessionCwd` the way the daemon
// would for a session that has not moved; a test that needs a moved cwd
// overrides the mock.
let rosterCwds: Map<number, string> = new Map()

function makeFakeClient(): HoustonClientType {
  kindHandlers = new Map()
  const base = {
    subscribeAll: ((handler: (msg: ServerMsg) => void) => {
      wiredHandler = handler
      return () => {
        if (wiredHandler === handler) wiredHandler = null
      }
    }) as (handler: (msg: ServerMsg) => void) => () => void,
    onFrame: (() => {}) as (session: number, offset: number, payload: Uint8Array) => void,
    onClose: (() => {}) as () => void,
    close: () => {},
    subscribe: ((kind: string, handler: (msg: never) => void) => {
      let set = kindHandlers.get(kind)
      if (!set) {
        set = new Set()
        kindHandlers.set(kind, set)
      }
      set.add(handler)
      return () => {
        set!.delete(handler)
      }
    }) as (kind: string, handler: (msg: never) => void) => () => void,
    gitBranch: vi.fn(),
    sessionCwd: vi.fn((session: number) =>
      Promise.resolve(rosterCwds.get(session) ?? '/tmp/project')) as (
      session: number
    ) => Promise<string>,
    waitForIdle: (() => Promise.resolve(true)) as (
      session: number,
      timeoutMs?: number,
      idleQuietMs?: number
    ) => Promise<boolean>,
    historyClear: vi.fn(),
    historyCount: vi.fn(),
    createSession: vi.fn(),
    addWorkspace: vi.fn(),
    respawnSession: vi.fn(),
    agentSessionsResumable: vi.fn(),
    sessionRunningProcs: vi.fn(),
    sendStdin: vi.fn(() => true),
    takeRecentDestroyIntent: vi.fn(() => null),
    confirmCloseSession: vi.fn(),
    confirmKillSession: vi.fn(),
    orchestrationSettingsGet: vi.fn(),
    orchestrationSet: vi.fn(),
    inboxList: vi.fn(),
    inboxAck: vi.fn(),
    inboxResolve: vi.fn(),
    inboxDeliverNow: vi.fn(),
    routineList: vi.fn(),
    routineCreate: vi.fn(),
    routineUpdate: vi.fn(),
    routineDelete: vi.fn(),
    routineRunNow: vi.fn(),
    routineRuns: vi.fn()
  }
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return () => undefined
    }
  }) as unknown as HoustonClientType
}

let lastClient: HoustonClientType | null = null

const connectMock = vi.hoisted(() => vi.fn<() => Promise<HoustonClientType>>())

connectMock.mockImplementation(async () => {
  const client = makeFakeClient()
  lastClient = client
  wiredHandler = null
  return client
})

vi.mock('../houston/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../houston/client')>()
  return {
    ...actual,
    HoustonClient: { connect: connectMock }
  }
})

const { App } = await import('../App')
await import('../components/SettingsView')
await import('../components/BrowserPane')
const { setSettingsNavForTests } = await import('../settingsNav')

function installHoustonBridge(): void {
  ;(window as unknown as { houston: Window['houston'] }).houston = {
    getConfig: vi.fn().mockResolvedValue({ port: 0, token: 'test-token', pid: 0, protocol: 29 }),
    pickDirectory: vi.fn().mockResolvedValue(null),
    windowControl: vi.fn(),
    isFocused: vi.fn().mockResolvedValue(true),
    setZoomFactor: vi.fn(),
    saveImage: vi.fn().mockResolvedValue(''),
    saveReview: vi.fn().mockResolvedValue(''),
    openExternal: vi.fn(),
    listSkills: vi.fn().mockResolvedValue([]),
    writeSkill: vi.fn().mockResolvedValue({ ok: true }),
    deleteSkill: vi.fn().mockResolvedValue({ ok: true }),
    readDir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    statFile: vi.fn().mockResolvedValue(null),
    pathKind: vi.fn().mockResolvedValue(null),
    pickerListDirs: vi.fn().mockResolvedValue(null),
    homeDir: vi.fn().mockResolvedValue('/home/test'),
    pickFile: vi.fn().mockResolvedValue(null),
    getPathForFile: vi.fn().mockReturnValue(''),
    openPath: vi.fn().mockResolvedValue({ ok: true }),
    listShells: vi.fn().mockResolvedValue([]),
    getLogsDir: vi.fn().mockResolvedValue('/home/test/.houston/logs'),
    setBackgroundColor: vi.fn(),
    setAllowedRoots: vi.fn()
  }
}
installHoustonBridge()

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export function resetHarness(): void {
  ghosttyMock.reset()
  mockWidth = 400
  mockHeight = 300
  lastClient = null
  wiredHandler = null
  rosterCwds = new Map()
  connectMock.mockClear()
  installHoustonBridge()
  resetNotificationStoreForTests()
  resetPaneNoticeRingsForTests()
  setRailViewForTests({ view: null, hidden: [] })
  resetRailWidthForTests()
  resetScmWidthForTests()
}

export function engineCounts(): { constructed: number; disposed: number } {
  return {
    constructed: ghosttyMock.createCount,
    disposed: ghosttyMock.disposeSpy.mock.calls.length
  }
}

function getLastClient(): HoustonClientType {
  if (!lastClient) throw new Error('no HoustonClient connected yet — call renderReadyApp() first')
  return lastClient
}

export function currentClient(): HoustonClientType {
  return getLastClient()
}

export function deliverHelloOk(
  overrides: Partial<Extract<ServerMsg, { type: 'hello_ok' }>> = {}
): void {
  const msg: Extract<ServerMsg, { type: 'hello_ok' }> = {
    type: 'hello_ok',
    protocol: 29,
    sessions: [],
    workspaces: [],
    tags: [],
    safe_mode: { disable_auto_restore: false, disable_swarm_autolaunch: false },
    snapshot_attach: false,
    snapshot_format_version: 0,
    ...overrides
  }
  act(() => {
    getLastClient()
    rosterCwds = new Map(msg.sessions.map((s) => [s.id, s.cwd]))
    wiredHandler?.(msg)
  })
}

export function deliverControl(msg: ServerMsg): void {
  act(() => {
    getLastClient()
    if (msg.type === 'session_created') rosterCwds.set(msg.info.id, msg.info.cwd)
    wiredHandler?.(msg)
  })
}

// Deliver one message to a component's own `client.subscribe(kind, …)` handler.
export function deliverClientMsg(kind: string, msg: unknown): void {
  act(() => {
    getLastClient()
    for (const handler of Array.from(kindHandlers.get(kind) ?? [])) {
      ;(handler as (m: unknown) => void)(msg)
    }
  })
}

export function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 1,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false,
    ...overrides
  } as SessionInfo
}

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return { path: '/tmp/project', name: 'project', ...overrides }
}

export function makeSwarm(overrides: Partial<SwarmInfo> = {}): SwarmInfo {
  return {
    id: 1,
    name: 'swarm-1',
    root_dir: '/tmp/swarm-root',
    goal: 'goal',
    status: 'active',
    created_at: 0,
    budget_minutes: 0,
    severity: 'none',
    ...overrides
  }
}

export interface AppHarness {
  container: HTMLDivElement
  root: Root
  unmount: () => void
}

async function flushBootConnect(): Promise<void> {
  await connectMock.mock.results[0]?.value
  const MAX_TICKS = 200
  let ticks = 0
  while ((!lastClient || wiredHandler === null) && ticks < MAX_TICKS) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    ticks++
  }
  if (!lastClient || wiredHandler === null) {
    throw new Error(
      `flushBootConnect: App never wired a client after ${MAX_TICKS} macrotask ticks — ` +
        `lastClient=${lastClient ? 'present' : 'undefined'}, subscribeAll=${
          wiredHandler === null ? 'never called' : 'registered'
        }. Expected App.tsx's boot effect to call Client.connect() and its ` +
        `.then(client => wire(client, true)) to call client.subscribeAll(...) before any test ` +
        `delivers a ServerMsg; delivering one earlier is silently dropped.`
    )
  }
}

export async function renderReadyApp(
  hello: Partial<Extract<ServerMsg, { type: 'hello_ok' }>> = {}
): Promise<AppHarness> {
  act(() => setSettingsNavForTests({ open: false, section: 'appearance' }))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<App />)
  })
  await flushBootConnect()
  deliverHelloOk({
    sessions: [makeSession()],
    workspaces: [makeWorkspace()],
    ...hello
  })
  await act(async () => {
    await flushGhosttyAttach()
  })
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

export async function settleLazySurface(present: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (present()) return
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
  throw new Error(
    `${what} never left its Suspense fallback: precondition still false after 60 ticks ` +
      `(document.body has ${document.body.childElementCount} child element(s))`
  )
}

export function toggleSettings(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true })
    )
  })
}
