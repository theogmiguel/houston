#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'
import { webkit } from 'playwright'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const [story, out] = positional
if (!story || !out) {
  console.error('usage: node ui/harness/shot.mjs <story> <out.png> [--width N] [--height N] [--theme T] [--scale N]')
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

const port = await freePort()
const vite = spawn('bunx', ['vite', '--port', String(port), '--strictPort', '--clearScreen', 'false'], {
  cwd: uiDir,
  stdio: ['ignore', 'pipe', 'pipe']
})
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
  vite.kill()
  console.error(`vite did not answer on ${url} within 20s\n${viteLog}`)
  process.exit(1)
}

try {
  const browser = await webkit.launch()
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
  await browser.close()
  console.log(`wrote ${out} (${width}x${height}@${scale}, theme ${theme}, story ${story})`)
  if (errors.length) {
    console.error(`page errors (${errors.length}):\n` + errors.join('\n'))
    process.exitCode = 1
  }
} finally {
  vite.kill()
}
