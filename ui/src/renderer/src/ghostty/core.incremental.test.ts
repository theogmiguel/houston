// @vitest-environment node
import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { GhosttyTerminalCore } from './core'
import { GhosttyRuntime } from './runtime'
const cores: GhosttyTerminalCore[] = []
afterEach(() => { cores.splice(0).forEach(core => core.dispose()) })
it('real WASM preserves OSC, DCS, CSI, UTF-8, modes and replies across arbitrary write boundaries', async () => {
  const runtime = await GhosttyRuntime.loadFromBytes(
    readFileSync(new URL('./vendor/ghostty-vt.wasm', import.meta.url)),
    readFileSync(new URL('./vendor/ghostty-write-pty.wasm', import.meta.url)))
  for (const stream of [
    'hello\x1b]0;title\x07\x1b]8;;https://example.test\x1b\\é🙂link\x1b]8;;\x1b\\\x1bP$qm\x1b\\\x1b[38;2;17;91;203mRGB\x1b[?1002h\x1b[?2004h\x1b[6n\x1b[c',
    '\x1b]52;c;' + 'a'.repeat(1048576) + '\x07after\x1b[6n',
    '\x1bP' + 'x'.repeat(1048576) + '\x1b\\after\x1b[6n'
  ]) {
    const results = []
    for (const size of [Infinity, stream.length > 10000 ? 262144 : 1]) {
      const replies: string[] = []
      const core = await GhosttyTerminalCore.create(80, 24, 8, 17,
        { foreground: { r: 229, g: 231, b: 235 }, background: { r: 12, g: 12, b: 12 }, cursor: { r: 255, g: 255, b: 255 } },
        data => replies.push(data), runtime)
      cores.push(core)
      const bytes = new TextEncoder().encode(stream)
      for (let offset = 0; offset < bytes.length; offset += size) core.write(bytes.subarray(offset, offset + size))
      results.push({ snapshot: core.snapshot(), mouse: core.isMouseTracking(), alternate: core.isAlternateScreen(), paste: core.encodePaste('é🙂'), replies: replies.join('') })
    }
    expect(results[0].replies).toContain("\x1b[")
    expect(results[1]).toEqual(results[0])
  }
})

