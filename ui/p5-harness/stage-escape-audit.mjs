import { chromium } from 'playwright'
import { prep } from './prep.mjs'

const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8931/?freeze'
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 900, height: 1000 } })
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__setView === 'function')
const cases = await page.evaluate(() => window.__cases)

let anyBad = 0
for (const c of cases) {
  await page.evaluate(([id]) => window.__setView(id, 'old', true), [c.id])
  await page.waitForTimeout(80)
  if (c.prep && c.prep.length) {
    const r = await prep(page, c.prep)
    if (!r.ok) throw new Error(`case ${c.id}: prep failed — ${r.why}`)
    await page.waitForTimeout(140)
  }
  const r = await page.evaluate((shootViewport) => {
    const el = document.querySelector('[data-stage]').getBoundingClientRect()
    const stage = shootViewport
      ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight }
      : el
    const els = [...document.querySelectorAll('[data-stage] button, [data-stage] [role="button"], [data-stage] [role="separator"], [data-stage] input, [data-stage] textarea')]
    const out = els.map((e) => {
      const b = e.getBoundingClientRect()
      const inside = b.left >= stage.left && b.top >= stage.top && b.right <= stage.right && b.bottom <= stage.bottom
      const cs = getComputedStyle(e)
      const stageEl = document.querySelector('[data-stage]')
      let fixed = false
      for (let n = e; n && n !== stageEl; n = n.parentElement) {
        if (getComputedStyle(n).position === 'fixed') { fixed = true; break }
      }
      const invisible = cs.visibility === 'hidden' || cs.opacity === '0' || (b.width === 0 && b.height === 0)
      const why = invisible ? 'hidden' : fixed ? 'escaped' : 'clipped'
      return { inside, why, label: (e.getAttribute('title') || e.getAttribute('aria-label') || (e.textContent || '').trim()).slice(0, 28) }
    })
    return { stage: [stage.width, stage.height], total: out.length, out: out.filter((o) => !o.inside) }
  }, !!c.shootViewport)
  const escaped = r.out.filter((o) => o.why === 'escaped')
  const clipped = r.out.filter((o) => o.why === 'clipped')
  const hidden = r.out.filter((o) => o.why === 'hidden')
  const flag = escaped.length ? 'ESCAPED' : clipped.length ? 'clipped' : 'ok'
  if (escaped.length) anyBad++
  console.log(
    `${flag.padEnd(8)} ${c.id.padEnd(22)} stage ${String(r.stage[0]).padStart(4)}x${String(r.stage[1])}  ` +
      `${r.total} interactive · ${escaped.length} escaped, ${clipped.length} clipped, ${hidden.length} hidden` +
      (c.shootViewport ? ' [viewport]' : '') +
      (escaped.length ? `\n           ESCAPED: ${escaped.map((o) => o.label || '(unnamed)').join(' | ')}` : '') +
      (clipped.length ? `\n           clipped: ${clipped.map((o) => o.label || '(unnamed)').join(' | ')}` : '')
  )
}
console.log(`\n${cases.length - anyBad}/${cases.length} cases photograph every VISIBLE interactive element they enumerate`)
await browser.close()
if (anyBad) process.exitCode = 1
