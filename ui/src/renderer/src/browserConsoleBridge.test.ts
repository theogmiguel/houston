import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { expect, it } from 'vitest'

it('buffers document-start console entries until the handler exists and flushes within the ring bounds', () => {
  const messages: { level: string; text: string }[] = []
  const originals: unknown[][] = []
  const listeners: Record<string, (event: Record<string, unknown>) => void> = {}
  const window: {
    addEventListener: (name: string, fn: (event: Record<string, unknown>) => void) => void
    webkit?: { messageHandlers: { trConsole: { postMessage: (raw: string) => void } } }
    __trConsoleFlush?: () => void
  } = { addEventListener: (name, fn) => { listeners[name] = fn } }
  const console = Object.fromEntries(['log', 'debug', 'info', 'warn', 'error'].map(level =>
    [level, (...args: unknown[]) => { originals.push(args); return 'original-result' }]))
  const context = createContext({ window, console })
  const source = readFileSync(resolve(process.cwd(), '../src-tauri/src/browser/console.js'), 'utf8')
  runInContext(source, context)
  runInContext(source, context)
  for (let i = 0; i < 300; i++) expect(console.log(String(i))).toBe('original-result')
  console.warn('x'.repeat(10000))
  window.webkit = { messageHandlers: { trConsole: { postMessage: raw => messages.push(JSON.parse(raw)) } } }
  expect(window.__trConsoleFlush).toBeTypeOf('function')
  window.__trConsoleFlush!()
  expect(messages).toHaveLength(256)
  expect(messages[0].text).toBe('45')
  expect(messages.at(-1)!.text).toHaveLength(4096)
  window.__trConsoleFlush!()
  expect(messages).toHaveLength(256)
  listeners.error({ message: 'uncaught', filename: 'page.js', lineno: 4 })
  listeners.unhandledrejection({ reason: 'rejected' })
  expect(messages.at(-2)!.text).toContain('uncaught page.js 4')
  expect(messages.at(-1)!.text).toContain('Unhandled rejection rejected')
  expect(originals).toHaveLength(301)
})
