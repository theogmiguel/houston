import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { prep } from './prep.mjs'
import { captureStage } from './capture.mjs'

// The old-vs-new legs compare two sides inside ONE page, so a change to the shared
// stylesheet lands on both sides at once and reports 0 however large it is. This
// rotates the axis: one side across two runs, with a pre-vs-pre control that must be 0.
const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8931/?freeze'
const THEME = process.env.THEME || 'graphite'
const MOTION = process.env.MOTION || 'no-preference'
const OUT = process.env.OUT
if (!OUT) {
  console.error('OUT=<dir> is required — the directory this run writes its snapshot into')
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 900, height: 1000 } })
await page.emulateMedia({ reducedMotion: MOTION })
await page.goto(URL, { waitUntil: 'networkidle' })
await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), THEME)
await page.waitForFunction(() => typeof window.__setView === 'function')

const cases = await page.evaluate(() => window.__cases)
const manifest = []

for (const c of cases) {
  await page.mouse.move(page.viewportSize().width - 1, page.viewportSize().height - 1)
  await page.evaluate(([id]) => window.__setView(id, 'new', true), [c.id])
  await page.waitForTimeout(80)
  if (c.prep && c.prep.length) {
    const r = await prep(page, c.prep)
    if (!r.ok) throw new Error(`case ${c.id}: prep step failed — ${r.why}`)
    await page.waitForTimeout(140)
  }
  const tree = await captureStage(page, [])
  if (!tree) throw new Error(`case ${c.id}: stage has no mounted content — nothing was captured`)
  const el = await page.$('[data-stage]')
  const png = c.shootViewport ? await page.screenshot() : await el.screenshot()
  writeFileSync(`${OUT}/${c.id}.json`, JSON.stringify(tree))
  writeFileSync(`${OUT}/${c.id}.png`, png)
  manifest.push(c.id)
  console.log(`captured ${c.id}`)
}

writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ theme: THEME, motion: MOTION, cases: manifest }, null, 2))
console.log(`\n${manifest.length} cases -> ${OUT} (theme=${THEME}, motion=${MOTION})`)
await browser.close()
