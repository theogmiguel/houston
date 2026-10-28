#!/usr/bin/env node
// Capture every story in the renderer harness, in both chrome themes, at 1280x800.
// Usage: node scripts/capture-stories.mjs <outDir> [filterRegex] -> <outDir>/<theme>/<story>.png;
// exits non-zero and names every story that fails to render.
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const THEMES = ['graphite', 'paper']
const VIEWPORT = { width: 1280, height: 800 }
// Covers the harness's post-mount effects and 150-250ms transitions after fonts load.
const SETTLE_MS = 400
// Four pages keep a full run near ten minutes without starving the vite dev server.
const WORKERS = 4
const [outDirArg, filter] = process.argv.slice(2)
if (!outDirArg) {
  console.error('usage: node scripts/capture-stories.mjs <outDir> [filterRegex]')
  process.exit(2)
}
let filterPattern = null
if (filter) {
  try {
    filterPattern = new RegExp(filter)
  } catch (error) {
    console.error(`filterRegex "${filter}" is not a valid regular expression: ${error.message}`)
    process.exit(2)
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const uiDir = path.join(root, 'ui')
const outDir = path.resolve(outDirArg)
const require = createRequire(path.join(uiDir, 'package.json'))
const { chromium } = require('playwright')

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })

const isWindows = process.platform === 'win32'
const port = await freePort()
// Detached on POSIX so stopping vite also stops esbuild and its helpers.
const vite = spawn(
  'bunx',
  ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--clearScreen', 'false'],
  { cwd: uiDir, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows }
)
let viteLog = ''
vite.stdout.on('data', (chunk) => (viteLog += chunk))
vite.stderr.on('data', (chunk) => (viteLog += chunk))
const stopVite = () => {
  if (vite.pid === undefined || vite.exitCode !== null) return
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-vite.pid, 'SIGTERM')
  } catch {}
}
process.on('exit', stopVite)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(128))

const indexUrl = `http://127.0.0.1:${port}/harness/index.html`
const deadline = Date.now() + 30_000
let viteReady = false
while (Date.now() < deadline) {
  try {
    if ((await fetch(indexUrl)).ok) {
      viteReady = true
      break
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!viteReady) {
  console.error(`vite did not answer on ${indexUrl} within 30s\n${viteLog}`)
  process.exit(1)
}

const launchBrowser = async () => {
  try {
    return await chromium.launch()
  } catch (first) {
    if (!isWindows && fs.existsSync('/usr/bin/google-chrome')) {
      try {
        return await chromium.launch({ executablePath: '/usr/bin/google-chrome' })
      } catch {}
    }
    throw first
  }
}

let browser
try {
  browser = await launchBrowser()
} catch (error) {
  console.error(`could not launch Chromium: ${String(error.message ?? error).replace(/\s*\n\s*/g, ' ')}`)
  process.exit(1)
}

const failures = []
const jobs = []
try {
  const index = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  await index.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await index.waitForSelector('a[href^="?story="]', { timeout: 120_000 })
  const names = await index.$$eval('a[href^="?story="]', (links) =>
    links.map((link) => decodeURIComponent(link.getAttribute('href').slice(7)))
  )
  await index.close()
  const selected = filterPattern ? names.filter((name) => filterPattern.test(name)) : names
  console.log(`capture-stories: ${selected.length} stories x ${THEMES.length} themes`)
  for (const theme of THEMES) for (const name of selected) jobs.push({ theme, name })
  const captures = jobs.length

  const worker = async () => {
    for (let job; (job = jobs.shift()); ) {
      const { theme, name } = job
      const file = path.join(outDir, theme, `${name.replace(/[^a-zA-Z0-9._-]+/g, '_')}.png`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
      const errors = []
      page.on('pageerror', (error) => errors.push(String(error.message ?? error)))
      try {
        await page.goto(`${indexUrl}?story=${encodeURIComponent(name)}&theme=${theme}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(SETTLE_MS)
        await page.screenshot({ path: file })
        if (errors.length) failures.push(`${theme}/${name}: ${errors[0]}`)
      } catch (error) {
        failures.push(`${theme}/${name}: ${String(error.message ?? error).split('\n')[0]}`)
      } finally {
        await page.close()
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
  if (!failures.length) console.log(`capture-stories: ${captures} captures in ${outDir}`)
} finally {
  await browser.close().catch(() => {})
}

if (failures.length) {
  console.error(`capture-stories: ${failures.length} failures`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
process.exit(0)
