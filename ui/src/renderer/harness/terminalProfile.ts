import '@fontsource/jetbrains-mono/400.css'
import { ghosttyRowText } from '../src/ghostty/core'
import { loadGhosttyRuntime } from '../src/ghostty/runtime'
import { GhosttyTerminalSurface, ghosttyPaintStats } from '../src/ghostty/surface'

const theme = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 12, g: 12, b: 12 },
  cursor: { r: 255, g: 255, b: 255 }
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const encoder = new TextEncoder()
let colourEpoch = 0
const harness = globalThis as unknown as {
  __trProfileCheckpoint: (name: string, edge: string) => Promise<void>
  __trTerminalProfile: { run: typeof run }
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (fraction: number) => sorted.length
    ? sorted[Math.ceil(sorted.length * fraction) - 1]!
    : null
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null }
}

async function createSurfaces(count: number) {
  const root = document.getElementById('terminals')!
  root.style.gridTemplateColumns = `repeat(${count === 1 ? 1 : count === 6 ? 3 : 4}, 1fr)`
  const surfaces: GhosttyTerminalSurface[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      const mount = document.createElement('div')
      mount.style.cssText = 'position:relative;min-width:0;min-height:0;overflow:hidden;'
      root.append(mount)
      const surface: GhosttyTerminalSurface = await GhosttyTerminalSurface.create(mount, {
        theme, font: { family: 'JetBrains Mono', size: 13 }, maxScrollbackLines: 1000,
        onData: (data, reply) => {
          if (!reply) setTimeout(() => surface.write(encoder.encode('\r\x1b[2K' + data)), 0)
        },
        onResize: () => {}, onSelectionChange: () => {}, beforeKey: () => true,
        onLinkActivate: () => {}
      })
      surfaces.push(surface)
    }
    surfaces[0]!.focus()
    await sleep(500)
    return surfaces
  } catch (error) {
    surfaces.forEach(surface => surface.dispose())
    root.replaceChildren()
    throw error
  }
}

function dispose(surfaces: GhosttyTerminalSurface[]) {
  surfaces.splice(0).forEach(surface => surface.dispose())
  document.getElementById('terminals')!.replaceChildren()
}

async function phase(name: string, operation: () => Promise<unknown>) {
  let visible = document.visibilityState === 'visible'
  let focused = document.hasFocus()
  const visibilityChanged = () => { visible &&= document.visibilityState === 'visible' }
  const blurred = () => { focused = false }
  document.addEventListener('visibilitychange', visibilityChanged)
  window.addEventListener('blur', blurred)
  try {
    await harness.__trProfileCheckpoint(name, 'before')
    const before = { ...ghosttyPaintStats() }
    const started = performance.now()
    const details = await operation()
    const elapsedMs = performance.now() - started
    const after = { ...ghosttyPaintStats() }
    await harness.__trProfileCheckpoint(name, 'after')
    return {
      name, elapsedMs, details,
      parseMs: after.parseMs - before.parseMs, parseBytes: after.parseBytes - before.parseBytes,
      paintMs: after.paintMs - before.paintMs, paintFrames: after.paintFrames - before.paintFrames,
      wasmCapacityBytes: (await loadGhosttyRuntime()).memory.buffer.byteLength,
      visible: visible && document.visibilityState === 'visible', focused: focused && document.hasFocus()
    }
  } finally {
    document.removeEventListener('visibilitychange', visibilityChanged)
    window.removeEventListener('blur', blurred)
  }
}

async function stream(surfaces: GhosttyTerminalSurface[], phaseMs: number, tag: string) {
  const frameTimes: number[] = []
  const echoes: number[] = []
  const pending: { token: string; at: number; paints: number }[] = []
  let frame = 0
  let previousFrame = performance.now()
  const streamStarted = previousFrame
  let streaming = true
  let sequence = 0
  let sent = 0
  let timeouts = 0
  const inputSurface = surfaces[0]!
  const input = document.querySelector<HTMLTextAreaElement>('textarea')!
  const sample = (now: number) => {
    if (streaming) frameTimes.push(now - previousFrame)
    previousFrame = now
    const snapshot = inputSurface.currentSnapshot()
    const text = snapshot?.rowData.map(ghosttyRowText).join('\n') ?? ''
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index]!
      if (inputSurface.paintCount() > item.paints && text.includes(item.token)) {
        echoes.push(now - item.at)
        pending.splice(index, 1)
      } else if (now - item.at >= 2000) {
        timeouts += 1
        pending.splice(index, 1)
      }
    }
    frame = requestAnimationFrame(sample)
  }
  frame = requestAnimationFrame(sample)
  const outputTimer = setInterval(() => {
    sequence += 1
    for (let index = surfaces.length === 1 ? 0 : 1; index < surfaces.length; index += 1) {
      surfaces[index]!.write(encoder.encode(`\x1b[3${sequence % 7 + 1}m${tag} ${sequence} é🙂\x1b[0m lorem ipsum dolor sit amet\r\n`))
    }
  }, 50)
  const inputTimer = setInterval(() => {
    const token = `${tag[0]}${++sent}é`
    pending.push({ token, at: performance.now(), paints: inputSurface.paintCount() })
    input.value = token
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: token }))
  }, 200)
  try {
    await sleep(phaseMs)
    const streamingMs = performance.now() - streamStarted
    streaming = false
    clearInterval(outputTimer)
    clearInterval(inputTimer)
    // Drain only outstanding input; do not extend streaming by a fixed deadline.
    const deadline = performance.now() + 2000
    while (pending.length && performance.now() < deadline) await sleep(20)
    timeouts += pending.length
    return {
      syntheticRafCadence: distribution(frameTimes), syntheticLoopbackInput: distribution(echoes),
      sufficientRafSamples: frameTimes.length >= Math.floor(streamingMs / 40),
      streamingMs, inputDrainMs: performance.now() - streamStarted - streamingMs,
      sent, timeouts, outputTicks: sequence
    }
  } finally {
    clearInterval(outputTimer)
    clearInterval(inputTimer)
    cancelAnimationFrame(frame)
  }
}

async function run(count: number, phaseMs: number, cycles: number) {
  if (![1, 6, 12].includes(count)) throw new Error(`terminal profile pane count ${count}; expected 1, 6 or 12`)
  const results = []
  let surfaces = await createSurfaces(count)
  const grids = surfaces.map(surface => ({ cols: surface.cols, rows: surface.rows }))
  try {
    if (grids.some(grid => grid.cols * grid.rows < 64)) throw new Error('terminal profile grid must hold at least 64 cells')
    // No continuous rAF probe or synthetic input during the idle CPU sample.
    results.push(await phase('idle', async () => { await sleep(phaseMs) }))
    results.push(await phase('stream-visible', () => stream(surfaces, phaseMs, 'VISIBLE')))
    if (count > 1) {
      const hidden = surfaces.slice(1)
      const mounts = [...document.getElementById('terminals')!.children].slice(1) as HTMLElement[]
      hidden.forEach(surface => surface.setPaused(true))
      mounts.forEach(mount => { mount.style.visibility = 'hidden' })
      await sleep(100)
      const paints = hidden.map(surface => surface.paintCount())
      let lastOutputTick = 0
      results.push(await phase('stream-paused-hidden', async () => {
        const detail = await stream(surfaces, phaseMs, 'HIDDEN')
        lastOutputTick = detail.outputTicks
        const hiddenPaintDeltas = hidden.map((surface, index) => surface.paintCount() - paints[index]!)
        if (hiddenPaintDeltas.some(delta => delta !== 0)) throw new Error(`terminal profile paused paint deltas ${hiddenPaintDeltas}; expected all zero`)
        return { ...detail, hiddenPaintDeltas }
      }))
      results.push(await phase('reveal', async () => {
        mounts.forEach(mount => { mount.style.visibility = 'visible' })
        hidden.forEach(surface => surface.setPaused(false))
        const deadline = performance.now() + 2000
        const matches = () => hidden.map((surface, index) => surface.paintCount() > paints[index]! &&
          (surface.currentSnapshot()?.rowData.map(ghosttyRowText).join('') ?? '').includes(`HIDDEN ${lastOutputTick} é🙂`))
        while (matches().some(match => !match) && performance.now() < deadline) await nextFrame()
        const restored = matches()
        if (restored.some(match => !match)) throw new Error(`terminal profile reveal restored ${restored.filter(Boolean).length}/${hidden.length} surfaces`)
        return { restored, paintDeltas: hidden.map((surface, index) => surface.paintCount() - paints[index]!) }
      }))
    }
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      results.push(await phase(`colour-lifecycle-${cycle}`, async () => {
        if (cycle > 0) surfaces = await createSurfaces(count)
        // Read 8192 distinct colours per surface, with each batch reaching a paint.
        for (let batch = 0; batch < 128; batch += 1) {
          for (const [surfaceIndex, surface] of surfaces.entries()) {
            let output = '\x1b[H'
            for (let column = 0; column < 64; column += 1) {
              const rgb = (colourEpoch * 12 + surfaceIndex) * 8192 + batch * 64 + column
              output += `\x1b[38;2;${rgb >> 16};${(rgb >> 8) & 255};${rgb & 255}mX`
            }
            surface.write(encoder.encode(output))
          }
          // Lifecycle churn needs paints, so bypass the unfocused output tick.
          surfaces.forEach(surface => surface.repaint())
          await nextFrame()
        }
        colourEpoch += 1
        return { paintedFrames: surfaces.map(surface => surface.paintCount()) }
      }))
      results.push(await phase(`disposed-${cycle}`, async () => {
        dispose(surfaces)
        await sleep(250)
      }))
    }
    return { count, grids, phaseMs, cycles, results }
  } finally {
    dispose(surfaces)
  }
}

harness.__trTerminalProfile = { run }
