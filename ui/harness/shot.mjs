#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'
import { chromium, webkit } from 'playwright'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const [story, out] = positional
if (!story || !out) {
  console.error('usage: node ui/harness/shot.mjs <story> <out.png> [--width N] [--height N] [--theme T] [--scale N] [--browser webkit|chromium] [--executable PATH]')
  process.exit(2)
}
const width = Number(opt('width', 1280))
const height = Number(opt('height', 800))
const theme = opt('theme', 'graphite')
const scale = Number(opt('scale', 2))

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })

const isWindows = process.platform === 'win32'
// WebKit matches WebKitGTK on Linux; Chromium is the closest to WebView2 on Windows.
const browserName = opt('browser', isWindows ? 'chromium' : 'webkit')
if (browserName !== 'webkit' && browserName !== 'chromium') {
  console.error(`unknown --browser "${browserName}"; expected webkit or chromium`)
  process.exit(2)
}

const port = await freePort()
// Detached on POSIX so the whole process group (bunx -> vite -> esbuild) can be signalled.
const vite = spawn(
  'bunx',
  ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--clearScreen', 'false'],
  { cwd: uiDir, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows }
)
vite.on('error', (e) => {
  console.error(`could not start vite via bunx: ${e.message}`)
  process.exit(1)
})

// Plain vite.kill() ends only the top process; on Windows the children keep running.
const killVite = () => {
  if (vite.pid === undefined || vite.exitCode !== null) return
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-vite.pid, 'SIGTERM')
  } catch {}
}
process.on('exit', killVite)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => process.exit(128))
}
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d))
vite.stderr.on('data', (d) => (viteLog += d))

const url = `http://127.0.0.1:${port}/harness/index.html?story=${encodeURIComponent(story)}&theme=${theme}`
const deadline = Date.now() + 20_000
let ready = false
while (Date.now() < deadline) {
  try {
    const r = await fetch(url)
    if (r.ok) {
      ready = true
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 250))
}
if (!ready) {
  console.error(`vite did not answer on ${url} within 20s\n${viteLog}`)
  process.exit(1)
}

const launchBrowser = async () => {
  const executablePath = opt('executable', undefined)
  if (executablePath) return (browserName === 'webkit' ? webkit : chromium).launch({ executablePath })
  if (browserName === 'webkit') return webkit.launch()
  const attempts = [() => chromium.launch()]
  if (isWindows) attempts.push(() => chromium.launch({ channel: 'msedge' }))
  else if (fs.existsSync('/usr/bin/google-chrome')) {
    attempts.push(() => chromium.launch({ executablePath: '/usr/bin/google-chrome' }))
  }
  let first
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (e) {
      first ??= e
    }
  }
  throw first
}

let browser
try {
  browser = await launchBrowser()
} catch (e) {
  const explicit = opt('executable', undefined)
  const missing = /Executable doesn't exist|Looks like Playwright|distribution .* is not found/i.test(String(e))
  console.error(
    missing && explicit
      ? `${browserName} executable not found at ${explicit}; pass an existing --executable PATH or omit it to use Playwright's ${browserName}`
      : missing
      ? `${browserName} is not installed for Playwright; run: bunx playwright install ${browserName} (or pass --executable PATH)`
      : `could not launch ${browserName}: ${String(e.message ?? e).replace(/[╔╗╚╝║═]/g, '').replace(/\s*\n\s*/g, ' ').trim()}`
  )
  process.exit(1)
}

try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(url, { waitUntil: 'networkidle' })
  // Wait for the bundled fonts before shooting: a frame taken first photographs
  // the fallback face, which is not the app.
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(150)
  await page.screenshot({ path: out, fullPage: false })
  console.log(`wrote ${out} (${width}x${height}@${scale}, theme ${theme}, story ${story})`)
  if (errors.length) {
    console.error(`page errors (${errors.length}):\n` + errors.join('\n'))
    process.exitCode = 1
  }
} finally {
  await browser.close().catch(() => {})
}
// The Vite pipes keep the event loop alive; exiting runs the process-tree cleanup.
process.exit(process.exitCode ?? 0)
