#!/usr/bin/env node
import { readFile, readdir, mkdir, mkdtemp, writeFile, realpath, lstat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir, loadavg, cpus } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { webkit } from 'playwright'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : args[index + 1]
}
const boundedInteger = (name, fallback, minimum, maximum) => {
  const raw = option(name, fallback)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`terminal profile --${name}=${raw}; expected integer ${minimum}..${maximum}`)
  }
  return value
}
const phaseMs = boundedInteger('phase-ms', 5000, 1000, 20000)
const cycles = boundedInteger('cycles', 3, 1, 5)
const output = option('out', path.join(await mkdtemp(path.join(tmpdir(), 'houston-terminal-profile-')), 'results.json'))
const root = fileURLToPath(new URL('../src/renderer', import.meta.url))
const checkout = fileURLToPath(new URL('../../', import.meta.url))
const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
const refuseOutput = () => { throw new Error(`terminal profile output ${output}; expected a regular file outside the checkout`) }
if (isWithin(checkout, path.resolve(output))) refuseOutput()
await mkdir(path.dirname(output), { recursive: true })
const canonicalOutput = path.join(await realpath(path.dirname(output)), path.basename(output))
if (isWithin(await realpath(checkout), canonicalOutput)) refuseOutput()
const existingOutput = await lstat(output).catch(error => {
  if (error.code !== 'ENOENT') throw error
  return undefined
})
if (existingOutput?.isSymbolicLink()) refuseOutput()
const clockTicks = process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) : null
const pageSize = process.platform === 'linux' ? Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) : null

async function processTree(rootPid) {
  if (process.platform !== 'linux') return []
  const rows = []
  const seen = new Set()
  const visit = async pid => {
    if (seen.has(pid)) return
    seen.add(pid)
    try {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
      let pssBytes = null
      try {
        const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
        pssBytes = Number(rollup.match(/^Pss:\s+(\d+)/m)?.[1]) * 1024
        if (!Number.isFinite(pssBytes)) pssBytes = null
      } catch {}
      rows.push({ pid, startTicks: Number(fields[19]), cpuTicks: Number(fields[11]) + Number(fields[12]), rssBytes: Number(fields[21]) * pageSize, pssBytes })
      // Follow only descendants of the BrowserServer process we launched.
      for (const tid of await readdir(`/proc/${pid}/task`)) {
        try {
          const children = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')
          for (const child of children.trim().split(/\s+/).filter(Boolean)) await visit(Number(child))
        } catch {}
      }
    } catch {}
  }
  await visit(rootPid)
  return rows
}

function metrics(before, after) {
  if (!clockTicks || !before.procs.length || !after.procs.length) return null
  const matched = after.procs.filter(row => before.procs.some(prev => prev.pid === row.pid && prev.startTicks === row.startTicks))
  const elapsedMs = after.monotonicMs - before.monotonicMs
  const ticks = matched.reduce((total, row) => total + row.cpuTicks - before.procs.find(prev => prev.pid === row.pid && prev.startTicks === row.startTicks).cpuTicks, 0)
  return {
    cpuPercentOneCore: ticks / clockTicks / (elapsedMs / 1000) * 100,
    matchedProcesses: matched.length,
    processSetStable: matched.length === before.procs.length && matched.length === after.procs.length,
    rssBeforeBytes: before.procs.reduce((total, row) => total + row.rssBytes, 0),
    rssAfterBytes: after.procs.reduce((total, row) => total + row.rssBytes, 0),
    pssBeforeBytes: before.procs.every(row => row.pssBytes !== null) ? before.procs.reduce((total, row) => total + row.pssBytes, 0) : null,
    pssAfterBytes: after.procs.every(row => row.pssBytes !== null) ? after.procs.reduce((total, row) => total + row.pssBytes, 0) : null
  }
}

const checkpoints = []
const errors = []
const results = {
  profile: 'Vite development modules; vendored WASM; standalone Playwright WebKit',
  scope: 'production terminal surfaces, no daemon, PTY, transport, React grid or Tauri host',
  limits: [
    'Debug/development diagnostics, not release baselines or regression floors.',
    'Playwright WebKit is not the installed WebKitGTK/Tauri runtime; native memory corruption remains separate.',
    'Input is a synthetic textarea event and timer loopback, ending at a submitted canvas paint, not PTY echo or compositor presentation.',
    'Hidden surfaces use setPaused and retain their parsers; snapshot hibernation, reattachment and daemon recovery require native M12.',
    'Idle has no continuous rAF/input probe; the focused cursor still blinks.',
    'CPU and memory cover the launched browser tree only; Vite/driver CPU is excluded. RSS sums count shared pages repeatedly; PSS is preferred.',
    'CPU uses matched PID/start-time endpoints; changing process sets invalidate comparisons. Disposal does not force GC; WASM capacity is an allocator high-water mark.',
    'Short diagnostic run; record competing load and repeat on an idle machine before drawing timing conclusions.'
  ],
  logicalCpus: cpus().length, phaseMs, cycles, clockTicks, pageSize,
  rounds: [], checkpoints, errors
}
let vite
let browserServer
let browser
try {
  vite = await createServer({
    configFile: false, root, cacheDir: path.join(path.dirname(output), 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{
      name: 'terminal-profile-page',
      configureServer(server) {
        server.middlewares.use('/terminal-profile', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end('<!doctype html><html><head><meta charset="UTF-8"><title>Terminal profile</title></head><body style="margin:0;background:#0c0c0c"><main id="terminals" style="display:grid;gap:8px;width:1280px;height:900px"></main><script type="module" src="/harness/terminalProfile.ts"></script></body></html>')
        })
      }
    }]
  })
  await vite.listen()
  browserServer = await webkit.launchServer({ headless: true })
  results.browserPid = browserServer.process().pid
  browser = await webkit.connect(browserServer.wsEndpoint())
  results.browserVersion = browser.version()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  let count = 0
  await page.exposeFunction('__trProfileCheckpoint', async (name, edge) => {
    const procs = await processTree(results.browserPid)
    checkpoints.push({ count, name, edge, monotonicMs: performance.now(), loadAverage: loadavg(), procs })
  })
  await page.goto(new URL('terminal-profile', vite.resolvedUrls.local[0]).href)
  await page.waitForFunction(() => !!globalThis.__trTerminalProfile, undefined, { timeout: 20000 })
  for (count of [1, 6, 12]) {
    console.error(`terminal profile: ${count} surfaces, idle/stream ${phaseMs} ms each, ${cycles} colour/disposal cycles`)
    let deadline
    let round
    try {
      round = await Promise.race([
        page.evaluate(({ count, phaseMs, cycles }) => globalThis.__trTerminalProfile.run(count, phaseMs, cycles), { count, phaseMs, cycles }),
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error(`terminal profile ${count} surfaces exceeded round deadline`)), phaseMs * 3 + cycles * 15000 + 20000)
        })
      ])
    } finally {
      clearTimeout(deadline)
    }
    for (const phase of round.results) {
      const before = checkpoints.find(row => row.count === count && row.name === phase.name && row.edge === 'before')
      const after = checkpoints.find(row => row.count === count && row.name === phase.name && row.edge === 'after')
      phase.system = metrics(before, after)
      if (phase.details?.sent !== undefined) {
        phase.inputDeliveryValid = phase.details.sent > 0 && phase.details.timeouts === 0 &&
          phase.details.syntheticLoopbackInput.samples === phase.details.sent
        if (!phase.inputDeliveryValid) errors.push(`${count} surfaces ${phase.name}: delivered ${phase.details.syntheticLoopbackInput.samples}/${phase.details.sent} inputs, ${phase.details.timeouts} timed out`)
      }
      phase.diagnosticTimingValid = phase.visible && phase.focused &&
        (process.platform !== 'linux' || phase.system?.processSetStable === true) &&
        phase.details?.sufficientRafSamples !== false &&
        phase.inputDeliveryValid !== false
    }
    results.rounds.push(round)
    await writeFile(output, JSON.stringify(results, null, 2) + '\n')
  }
  if (errors.length) throw new Error(`terminal profile page errors: ${errors.join('; ')}`)
} catch (error) {
  results.failure = String(error)
  process.exitCode = 1
} finally {
  for (const close of [() => browser?.close(), () => browserServer?.close(), () => vite?.close()]) {
    try { await close() } catch (error) {
      errors.push(`cleanup: ${error}`)
      process.exitCode = 1
    }
  }
  await writeFile(output, JSON.stringify(results, null, 2) + '\n')
  console.log(output)
}
