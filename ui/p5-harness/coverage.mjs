import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { prep } from './prep.mjs'

const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8951/?freeze'
const SEL_FILE = process.env.SELECTORS
const selectors = readFileSync(SEL_FILE, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('#'))

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__setView === 'function')
const cases = await page.evaluate(() => window.__cases)

const totals = new Map(selectors.map((s) => [s, 0]))
const where = new Map(selectors.map((s) => [s, []]))

for (const c of cases) {
  await page.evaluate((id) => window.__setView(id, 'old'), c.id)
  await page.waitForTimeout(80)
  if (c.prep && c.prep.length) {
    const r = await prep(page, c.prep)
    if (!r.ok) throw new Error(`case ${c.id}: prep failed — ${r.why}`)
    await page.waitForTimeout(140)
  }
  const counts = await page.evaluate((sels) => {
    const stage = document.querySelector('[data-stage]')
    return sels.map((s) => {
      // `:before`/`:after` are the only pseudo-elements with a legacy single-colon
      // form; `querySelectorAll` accepts the selector but returns an empty
      // NodeList for it, which reads as a false GAP, so they are stripped here too.
      const base = s
        .replace(/::[a-z-]+(\([^)]*\))?/g, '')
        .replace(/:(before|after)\b/g, '')
        .replace(/:(hover|focus-visible|active|disabled)/g, '')
      try {
        return stage ? stage.querySelectorAll(base).length : 0
      } catch {
        return -1
      }
    })
  }, selectors)
  selectors.forEach((s, i) => {
    if (counts[i] > 0) {
      totals.set(s, totals.get(s) + counts[i])
      where.get(s).push(c.id)
    } else if (counts[i] === -1) {
      totals.set(s, -1)
    }
  })
}

let uncovered = 0
for (const s of selectors) {
  const n = totals.get(s)
  if (n === -1) {
    console.log(`ERR   ${s.padEnd(34)} unparseable selector`)
    uncovered++
  } else if (n === 0) {
    console.log(`GAP   ${s.padEnd(34)} rendered by NO case`)
    uncovered++
  } else {
    console.log(`ok    ${s.padEnd(34)} ${String(n).padStart(3)} node(s) across ${where.get(s).length} case(s)`)
  }
}
console.log(
  `\n${selectors.length - uncovered}/${selectors.length} selectors reachable across ${cases.length} cases` +
    (uncovered ? ` · ${uncovered} UNCOVERED — each needs a smoke row or a new case` : '')
)
await browser.close()
if (uncovered) process.exitCode = 1
