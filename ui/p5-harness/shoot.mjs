import { chromium } from 'playwright'
import { prep } from './prep.mjs'
import { assertOldSideFresh } from './freshness.mjs'

assertOldSideFresh()

const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8931/?freeze'
const THEME = process.env.THEME || 'graphite'
const MOTION = process.env.MOTION || 'no-preference'

if (process.env.CONTROL) {
  console.error(
    `CONTROL is not a mode of shoot.mjs — got '${process.env.CONTROL}'.\n` +
      `The bitmap leg measures its own noise floor per case, on every run: each side is\n` +
      `shot twice and compared against itself ('floor NNpx/N' in each row), and a case\n` +
      `only reports ok when the old-vs-new delta is at or below it. Run it plainly.\n` +
      `CONTROL=old|new is implemented by styles.mjs and states.mjs, which compare one\n` +
      `pair per case and therefore need the floor as a separate invocation.`
  )
  process.exit(2)
}

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 900, height: 1000 } })
await page.emulateMedia({ reducedMotion: MOTION })
await page.goto(URL, { waitUntil: 'networkidle' })
await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), THEME)
await page.waitForFunction(() => typeof window.__setView === 'function')

const ONLY = process.env.CASE ? process.env.CASE.split(',').map((s) => s.trim()) : null
const allCases = await page.evaluate(() => window.__cases)
if (ONLY) {
  const unknown = ONLY.filter((id) => !allCases.some((c) => c.id === id))
  if (unknown.length) {
    console.error(
      `CASE names no such case: ${unknown.join(', ')}\nknown: ${allCases.map((c) => c.id).join(', ')}`
    )
    process.exit(2)
  }
}
const cases = ONLY ? allCases.filter((c) => ONLY.includes(c.id)) : allCases

const shot = async (id, side) => {
  await page.mouse.move(page.viewportSize().width - 1, page.viewportSize().height - 1)
  await page.evaluate(([i, s]) => window.__setView(i, s), [id, side])
  await page.waitForTimeout(60)
  const c = cases.find((x) => x.id === id)
  if (c.prep && c.prep.length) {
    const r = await prep(page, c.prep)
    if (!r.ok) throw new Error(`case ${id}: prep click failed — ${r.why}`)
    await page.waitForTimeout(140)
  }
  if (c.shootViewport) {
    return (await page.screenshot()).toString('base64')
  }
  const el = await page.$('[data-stage]')
  return (await el.screenshot()).toString('base64')
}

const compare = (a, b) =>
  page.evaluate(async ([A, B]) => {
    const load = (b64) =>
      new Promise((res, rej) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          const x = c.getContext('2d')
          x.drawImage(img, 0, 0)
          res({ d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height })
        }
        img.onerror = rej
        img.src = 'data:image/png;base64,' + b64
      })
    const p = await load(A)
    const q = await load(B)
    if (p.w !== q.w || p.h !== q.h) return { sizeMismatch: [p.w, p.h, q.w, q.h] }
    let n = 0
    let worst = 0
    let box = null
    for (let i = 0; i < p.d.length; i += 4) {
      let d = 0
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(p.d[i + k] - q.d[i + k]))
      if (d > 0) {
        n++
        if (d > worst) worst = d
        const px = (i / 4) % p.w
        const py = Math.floor(i / 4 / p.w)
        box = box
          ? [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)]
          : [px, py, px, py]
      }
    }
    return { pixels: p.w * p.h, differing: n, worst, box }
  }, [a, b])

// Each case is shot twice per side; the pass test is `differing <= floor`, because
// rasterisation noise on IDENTICAL DOM reaches ~41/255 per channel — the same order
// as the differences hunted, so a fixed zero threshold would fail on every run.
let above = 0
for (const c of cases) {
  const oldA = await shot(c.id, 'old')
  const newA = await shot(c.id, 'new')
  const oldB = await shot(c.id, 'old')
  const newB = await shot(c.id, 'new')
  const main = await compare(oldA, newA)
  const fOld = await compare(oldA, oldB)
  const fNew = await compare(newA, newB)
  const floor = Math.max(fOld.differing || 0, fNew.differing || 0)
  const fw = Math.max(fOld.worst || 0, fNew.worst || 0)
  const ok = !main.sizeMismatch && main.differing <= floor && main.worst <= fw
  if (!ok) above++
  console.log(
    `${(ok ? 'ok' : 'DIFF').padEnd(5)} ${c.id.padEnd(22)} ` +
      `${main.sizeMismatch ? 'SIZE ' + main.sizeMismatch.join('x') : main.differing + 'px worst ' + main.worst}` +
      `  ·  floor ${floor}px/${fw}` +
      (main.box && !ok ? `  box ${main.box.join(',')}` : '')
  )
}
console.log(
  `\n${cases.length - above}/${cases.length} at or below the noise floor · ${above} above` +
    (ONLY
      ? `\nNARROWED RUN — ${allCases.length - cases.length} of ${allCases.length} cases NOT measured. ` +
        `This is a diagnostic, not a verdict; the stage's full pass is what clears it.`
      : '')
)
await browser.close()
if (above) process.exitCode = 1
