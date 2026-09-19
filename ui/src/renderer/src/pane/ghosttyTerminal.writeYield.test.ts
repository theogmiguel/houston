// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { GhosttyPaneTerminal, type GhosttyTerminalInit } from './ghosttyTerminal'
import type { GhosttyTerminalSurface } from '../ghostty/surface'

function burnMs(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
  }
}

function attachedTerm(onParse: () => void): GhosttyPaneTerminal {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const surface = {
    cols: 80,
    rows: 24,
    write: () => onParse(),
    resetAndWrite: () => {},
    dispose: () => {},
    getBufferText: () => '',
    currentSnapshot: () => null
  } as unknown as GhosttyTerminalSurface
  const init: GhosttyTerminalInit = {
    host,
    theme: {},
    fontFamily: 'monospace',
    fontSize: 13,
    disableStdin: false,
    sessionId: 1,
    load: async () => surface,
    toGhosttyTheme: () => ({}) as never
  }
  return new GhosttyPaneTerminal(init)
}

describe('write completion yields to the event loop (charter §13.8)', () => {
  it('a burst past the budget advances the macrotask turn; a short one does not', async () => {
    let parses = 0
    const term = attachedTerm(() => {
      parses += 1
      burnMs(3)
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    let macrotask = 0
    const beat = setInterval(() => { macrotask += 1 }, 0)
    const stamps: number[] = []

    await new Promise<void>((done) => {
      let n = 0
      const next = (): void => {
        if (n === 8) { done(); return }
        n += 1
        stamps.push(macrotask)
        term.write(new Uint8Array(16), next)
      }
      next()
    })
    clearInterval(beat)

    expect(parses).toBe(8)
    expect(new Set(stamps).size).toBeGreaterThan(1)
    expect(new Set(stamps).size).toBeLessThan(stamps.length)
  })

  it('a burst that stays under the budget never leaves its macrotask turn', async () => {
    const term = attachedTerm(() => {})
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    let macrotask = 0
    const beat = setInterval(() => { macrotask += 1 }, 0)
    const stamps: number[] = []
    await new Promise<void>((done) => {
      let n = 0
      const next = (): void => {
        if (n === 8) { done(); return }
        n += 1
        stamps.push(macrotask)
        term.write(new Uint8Array(16), next)
      }
      next()
    })
    clearInterval(beat)

    expect(stamps).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})
