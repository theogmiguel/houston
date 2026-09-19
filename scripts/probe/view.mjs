import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startStaticServer } from './serve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const channel = arg('channel', 'probe')
const stateDir = join(process.env.HOME ?? '', `.houston-${channel}`)
const outDir = resolve(arg('out', join(stateDir, 'probe-out', 'shots')))
const port = Number(arg('port', '8791'))
const settleMs = Number(arg('settle', '4000'))
const panes = (arg('panes', '') || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)

async function playwright() {
  const entry = join(root, 'ui', 'node_modules', 'playwright', 'index.mjs')
  try {
    return await import(pathToFileURL(entry).href)
  } catch (e) {
    throw new Error(
      `cannot load Playwright from ${entry} (${e.message}) — it is a devDependency of ui/, ` +
        `so run: cd ui && bun install`
    )
  }
}

async function daemonConfig() {
  const path = join(stateDir, 'daemon.json')
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (e) {
    throw new Error(
      `cannot read ${path} (${e.message}) — no daemon is running on channel '${channel}'. ` +
        `Start one with: scripts/dev.sh --channel ${channel}`
    )
  }
  if (!raw.port || !raw.token) {
    throw new Error(`${path} has no port/token: ${JSON.stringify(raw)}`)
  }
  return { port: raw.port, token: raw.token }
}

const SEEN_FIRST_RUN = `try { localStorage.setItem('tr-drawer-notice-seen', 'true') } catch (e) {}`

function seedScript(workspace, ids) {
  const tree =
    ids.length === 1
      ? { kind: 'leaf', session: ids[0], id: 'probe-p0' }
      : {
          kind: 'split',
          dir: 'row',
          children: ids.map((s, i) => ({ kind: 'leaf', session: s, id: `probe-p${i}` })),
          weights: ids.map(() => 1 / ids.length)
        }
  const key = `tr-layout:${workspace}::g-default`
  return `try {
  localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify({ tree, cols: 2 }))})
  localStorage.setItem('tr-selected-workspace', ${JSON.stringify(workspace)})
} catch (e) {}`
}

async function main() {
  const config = await daemonConfig()
  const workspace = arg('workspace', join(stateDir, 'probe-workspace'))
  await mkdir(outDir, { recursive: true })

  const server = await startStaticServer({
    root: join(root, 'ui', 'out', 'renderer'),
    port,
    config
  })
  const { chromium } = await playwright()
  const browser = await chromium.launch()
  const written = []
  const logs = []
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    await page.addInitScript(SEEN_FIRST_RUN)
    if (panes.length > 0) await page.addInitScript(seedScript(workspace, panes))

    await page.goto(server.url, { waitUntil: 'load' })
    await page.waitForTimeout(settleMs)

    const shot = async (name, target) => {
      const file = join(outDir, name)
      await writeFile(file, await target.screenshot())
      written.push(file)
    }

    await shot('01-window.png', page)

    for (const [name, selector] of [
      ['02-orchestrator-badge.png', '[data-testid="orchestrator-badge"]'],
      ['03-origin-badge.png', '[data-testid="origin-badge"]']
    ]) {
      const el = page.locator(selector).first()
      if ((await el.count()) === 0) {
        logs.push(`[missing] no element matched ${selector}`)
        continue
      }
      await shot(name, el)
    }

    const badge = page.locator('[data-testid="orchestrator-badge"]').first()
    if ((await badge.count()) > 0) {
      await badge.click()
      await page.waitForTimeout(600)
      await shot('04-delegation-card.png', page)
    }
  } finally {
    await browser.close()
    await server.close()
  }

  console.log(`[view] served ${join(root, 'ui', 'out', 'renderer')} at ${server.url}`)
  console.log(`[view] daemon: channel=${channel} port=${config.port}`)
  for (const line of logs) console.log(`[view] page ${line}`)
  console.log(`[view] ${written.length} screenshot(s) in ${outDir}:`)
  for (const file of written) console.log(file)
  if (written.length === 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(`[view] ${e.message}`)
  process.exitCode = 1
})
