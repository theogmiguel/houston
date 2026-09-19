// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { GhosttyPaneTerminal, type GhosttyTerminalInit } from './ghosttyTerminal'
import type { GhosttyTerminalSurface } from '../ghostty/surface'

const CAP_BYTES = 4 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024

function chunk(byte: number): Uint8Array {
  return new Uint8Array(CHUNK_BYTES).fill(byte)
}

function surfaceStub(): { surface: GhosttyTerminalSurface; written: (string | Uint8Array)[] } {
  const written: (string | Uint8Array)[] = []
  const surface = {
    cols: 80,
    rows: 24,
    write: (data: string | Uint8Array) => {
      written.push(data)
    },
    resetAndWrite: () => {},
    dispose: () => {},
    getBufferText: () => '',
    currentSnapshot: () => null
  } as unknown as GhosttyTerminalSurface
  return { surface, written }
}

function harness(): {
  term: GhosttyPaneTerminal
  attach: (surface: GhosttyTerminalSurface) => void
  overflows: { total: number; cap: number }[]
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const overflows: { total: number; cap: number }[] = []
  let resolveLoad: (surface: GhosttyTerminalSurface) => void = () => {}
  const init: GhosttyTerminalInit = {
    host,
    theme: {},
    fontFamily: 'monospace',
    fontSize: 13,
    disableStdin: false,
    sessionId: 7,
    load: () =>
      new Promise<GhosttyTerminalSurface>((resolve) => {
        resolveLoad = resolve
      }),
    toGhosttyTheme: () => ({}) as never,
    onAttachOverflow: (total, cap) => {
      overflows.push({ total, cap })
    }
  }
  return { term: new GhosttyPaneTerminal(init), attach: (s) => resolveLoad(s), overflows }
}

describe('GhosttyPaneTerminal attach buffer', () => {
  it('holds no more than the cap while the engine is still loading', async () => {
    const { term, attach, overflows } = harness()
    const done = vi.fn()
    for (let i = 0; i < 40; i += 1) term.write(chunk(i), done)

    expect(overflows.length).toBeGreaterThan(0)
    expect(overflows.at(-1)?.cap).toBe(CAP_BYTES)

    const droppedCallbacks = done.mock.calls.length
    expect(droppedCallbacks).toBeGreaterThan(0)

    const { surface, written } = surfaceStub()
    attach(surface)
    await Promise.resolve()
    await Promise.resolve()

    const replayed = written.reduce((sum, w) => sum + w.length, 0)
    expect(replayed).toBeLessThanOrEqual(CAP_BYTES)
    expect(replayed + overflows.at(-1)!.total).toBe(40 * CHUNK_BYTES)
    expect((written.at(-1) as Uint8Array)[0]).toBe(39)
  })

  it('drops nothing and replays in order when the buffer stays under the cap', async () => {
    const { term, attach, overflows } = harness()
    const done = vi.fn()
    for (let i = 0; i < 4; i += 1) term.write(chunk(i), done)
    expect(overflows).toEqual([])
    expect(done).not.toHaveBeenCalled()

    const { surface, written } = surfaceStub()
    attach(surface)
    await Promise.resolve()
    await Promise.resolve()

    expect(written.map((w) => (w as Uint8Array)[0])).toEqual([0, 1, 2, 3])
    expect(done).toHaveBeenCalledTimes(4)
  })

  it('resumes the surviving head at a parser-safe boundary', async () => {
    const { term, attach } = harness()
    const withEscape = new Uint8Array(CHUNK_BYTES)
    withEscape.fill(0x41)
    withEscape[0] = 0x1b
    withEscape[1] = 0x5b
    withEscape[10] = 0x0a
    for (let i = 0; i < 17; i += 1) term.write(i === 1 ? withEscape : chunk(i))

    const { surface, written } = surfaceStub()
    attach(surface)
    await Promise.resolve()
    await Promise.resolve()

    const head = written[0] as Uint8Array
    expect(head.length).toBe(CHUNK_BYTES - 11)
    expect(head[0]).toBe(0x41)
  })
})
