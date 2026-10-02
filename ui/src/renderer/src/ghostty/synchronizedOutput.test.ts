// @vitest-environment node
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyTerminalCore, ghosttyRowText } from './core'
import { GhosttyRuntime } from './runtime'
import { SynchronizedOutput } from './synchronizedOutput'

let core: GhosttyTerminalCore | undefined
let gate: SynchronizedOutput | undefined

afterEach(() => {
  gate?.dispose()
  core?.dispose()
  vi.useRealTimers()
})

async function create() {
  vi.useFakeTimers()
  const runtime = await GhosttyRuntime.loadFromBytes(
    readFileSync(new URL('./vendor/ghostty-vt.wasm', import.meta.url)),
    readFileSync(new URL('./vendor/ghostty-write-pty.wasm', import.meta.url))
  )
  const color = { r: 255, g: 255, b: 255 }
  core = await GhosttyTerminalCore.create(
    80, 24, 8, 17, { foreground: color, background: color, cursor: color }, () => {}, runtime
  )
  const repaint = vi.fn()
  gate = new SynchronizedOutput(core, repaint)
  return { terminal: core, output: gate, repaint }
}

it('keeps the previous frame through a clear split across PTY messages', async () => {
  const { terminal, output, repaint } = await create()
  terminal.write('previous frame')
  let visible = ghosttyRowText(terminal.snapshot().rowData[0]!)
  terminal.write('\x1b[?202')
  terminal.write('6h\x1b[2J\x1b[H')
  if (!output.defer()) visible = ghosttyRowText(terminal.snapshot().rowData[0]!)
  expect(visible).toBe('previous frame')
  terminal.write('complete frame\x1b[?2026l')
  expect(output.defer()).toBe(false)
  expect(ghosttyRowText(terminal.snapshot().rowData[0]!)).toBe('complete frame')
  vi.advanceTimersByTime(1000)
  expect(repaint).not.toHaveBeenCalled()
})

it('recovers an interrupted frame within one second without extending the deadline', async () => {
  const { terminal, output, repaint } = await create()
  terminal.write('\x1b[?2026hinterrupted')
  expect(output.defer()).toBe(true)
  vi.advanceTimersByTime(900)
  terminal.write(' update')
  expect(output.defer()).toBe(true)
  vi.advanceTimersByTime(100)
  expect(repaint).toHaveBeenCalledOnce()
  expect(terminal.isSynchronizedOutput()).toBe(false)
  expect(output.defer()).toBe(false)
  expect(ghosttyRowText(terminal.snapshot().rowData[0]!)).toBe('interrupted update')
})

it('cancels pending recovery when a surface is disposed', async () => {
  const { terminal, output, repaint } = await create()
  terminal.write('\x1b[?2026h')
  expect(output.defer()).toBe(true)
  output.dispose()
  vi.advanceTimersByTime(1000)
  expect(repaint).not.toHaveBeenCalled()
})
