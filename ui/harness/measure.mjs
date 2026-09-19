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
const [story, selectors] = positional
if (!story || !selectors) {
  console.error("usage: node ui/harness/measure.mjs <story> '<sel>,<sel>' [--width N] [--height N] [--theme T]")
  process.exit(2)
}
const width = Number(opt('width', 1280))
const height = Number(opt('height', 800))
const theme = opt('theme', 'graphite')

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
  const page = await browser.newPage({ viewport: { width, height } })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(150)
  const out = await page.evaluate((sels) => {
    const want = [
      'fontSize',
      'fontWeight',
      'letterSpacing',
      'lineHeight',
      'color',
      'paddingTop',
      'paddingBottom',
      'paddingLeft',
      'paddingRight',
      'marginTop',
      'marginBottom',
      'borderBottomWidth',
      'borderBottomColor',
      'columnGap',
      'width',
      'height',
      'maxWidth',
      'alignItems',
      'borderRadius',
      'backgroundColor'
    ]
    return sels.map((sel) => {
      const el = document.querySelector(sel)
      if (!el) return { sel, missing: true }
      const cs = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      const o = { sel, box: { w: +box.width.toFixed(1), h: +box.height.toFixed(1) } }
      for (const k of want) o[k] = cs[k]
      return o
    })
  }, selectors.split(',').map((s) => s.trim()))
  for (const r of out) console.log(JSON.stringify(r))
  await browser.close()
} finally {
  vite.kill()
}
