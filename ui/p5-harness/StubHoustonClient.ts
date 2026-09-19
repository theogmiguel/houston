export * from '../src/renderer/src/houston/client.ts'

import type {
  HoustonClient as HoustonClientType,
  ServerMsg
} from '../src/renderer/src/houston/client.ts'

let wiredHandler: ((msg: ServerMsg) => void) | null = null

function makeFakeClient(): HoustonClientType {
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
    sessionCwd: (() => Promise.resolve('/home/dev/houston')) as (
      session: number
    ) => Promise<string>,
    waitForIdle: (() => Promise.resolve(true)) as (
      session: number,
      timeoutMs?: number,
      idleQuietMs?: number
    ) => Promise<boolean>,
    sendStdin: (() => true) as (session: number, data: string) => boolean,
    sessionVisibility: (() => {}) as (session: number, visible: boolean) => void,
    attachSession: (() => {}) as (session: number, replayBytes?: number) => void,
    resizeSession: (() => {}) as (session: number, cols: number, rows: number) => void
  }
  // `then`/`catch`/`finally` must NOT fall into the catch-all: the fake would look
  // thenable, so `Client.connect()`'s promise would resolve to the fake itself and
  // the boot `.then(client => wire(…))` would never fire.
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return () => undefined
    }
  }) as unknown as HoustonClientType
}

export function makeTerminalPaneClient(): HoustonClientType {
  return makeFakeClient()
}

let lastClient: HoustonClientType | null = null

export const HoustonClient = {
  connect: async (): Promise<HoustonClientType> => {
    const client = makeFakeClient()
    lastClient = client
    wiredHandler = null
    return client
  }
}

function currentClient(): HoustonClientType {
  if (!lastClient) throw new Error('StubHoustonClient: no client connected yet — mount App first')
  return lastClient
}

export function deliverToApp(msg: ServerMsg): void {
  currentClient()
  if (wiredHandler === null) {
    throw new Error(
      `deliverToApp(${msg.type}): App has not called subscribeAll yet — call this only after ` +
        `hello_ok has been delivered and awaited`
    )
  }
  wiredHandler(msg)
}

export function installHarnessBridge(): void {
  ;(window as unknown as { __harnessCall: (name: string) => void }).__harnessCall = (
    name: string
  ) => {
    const client = currentClient()
    if (name === 'disconnect') {
      client.onClose()
      return
    }
    if (name === 'error') {
      deliverToApp({
        type: 'error',
        message: 'daemon rejected the last operation',
        context: null
      })
      return
    }
    throw new Error(`__harnessCall: unknown action "${name}"`)
  }
}
