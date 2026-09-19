import { chromium } from 'playwright'
import { prep } from './prep.mjs'
import { assertOldSideFresh } from './freshness.mjs'

assertOldSideFresh()

const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8931/?freeze'
const ONLY = process.env.CASE ? process.env.CASE.split(',').map((s) => s.trim()) : []
const STATES = ['hover', 'focus-visible', 'active', 'focus-within']

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 900, height: 1000 } })
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__setView === 'function')
const cdp = await page.context().newCDPSession(page)
await cdp.send('DOM.enable')
await cdp.send('CSS.enable')

const cases = await page.evaluate(() => window.__cases)

const compare = (a, b) =>
  page.evaluate(async ([A, B]) => {
    const load = (b64) =>
      new Promise((res) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          const x = c.getContext('2d')
          x.drawImage(img, 0, 0)
          res({ d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height })
        }
        img.src = 'data:image/png;base64,' + b64
      })
    const p = await load(A)
    const q = await load(B)
    if (p.w !== q.w || p.h !== q.h) return { sizeMismatch: true }
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
    return { differing: n, worst, box: box && box.map((v) => v / 2) }
  }, [a, b])

const CONTROL = process.env.CONTROL
if (CONTROL && CONTROL !== 'old' && CONTROL !== 'new') {
  console.error(`CONTROL must be 'old' or 'new', got '${CONTROL}'`)
  process.exit(2)
}
const SIDE_A = CONTROL || 'old'
const SIDE_B = CONTROL || 'new'

async function shots(caseId, side) {
  await page.mouse.move(page.viewportSize().width - 1, page.viewportSize().height - 1)
  await page.evaluate(([c, s]) => window.__setView(c, s, true), [caseId, side])
  await page.waitForTimeout(80)
  const c = cases.find((x) => x.id === caseId)
  if (c.prep && c.prep.length) {
    const r = await prep(page, c.prep)
    if (!r.ok) throw new Error(`case ${caseId}: prep click failed — ${r.why}`)
    await page.waitForTimeout(140)
  }
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-stage] button, [data-stage] [role="button"], [data-stage] [role="separator"], [data-stage] input, [data-stage] textarea')].map(
      (e, i) => {
        e.setAttribute('data-probe-idx', String(i))
        return (
          e.tagName.toLowerCase() +
          (e.getAttribute('title') ? `[${e.getAttribute('title').slice(0, 22)}]` : '') +
          (e.getAttribute('role') === 'button' && e.tagName !== 'BUTTON' ? '(row)' : '')
        )
      }
    )
  )
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const nodeIds = []
  for (let i = 0; i < labels.length; i++) {
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `[data-stage] [data-probe-idx="${i}"]`
    })
    nodeIds.push(nodeId)
  }
  const el = await page.$('[data-stage]')
  const grab = c.shootViewport
    ? async () => (await page.screenshot()).toString('base64')
    : async () => (await el.screenshot()).toString('base64')
  const CHAINED = new Set(['hover', 'active', 'focus-within'])
  const chainFor = async (i) => {
    await page.evaluate((idx) => {
      const el = document.querySelector(`[data-stage] [data-probe-idx="${idx}"]`)
      document.querySelectorAll('[data-probe-chain]').forEach((n) => n.removeAttribute('data-probe-chain'))
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        e.setAttribute('data-probe-chain', '')
      }
    }, i)
    const { nodeIds: chain } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: '[data-probe-chain]'
    })
    return chain
  }

  const out = []
  for (let i = 0; i < nodeIds.length; i++) {
    for (const st of STATES) {
      const targets = CHAINED.has(st) ? await chainFor(i) : [nodeIds[i]]
      for (const n of targets) {
        await cdp.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: [st] })
      }
      await page.waitForTimeout(20)
      out.push({ i, label: labels[i], state: st, png: await grab() })
      for (const n of targets) {
        await cdp.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: [] })
      }
    }
  }
  return out
}

const targets = ONLY.length ? cases.filter((c) => ONLY.includes(c.id)) : cases
if (!targets.length)
  throw new Error(`CASE=${ONLY.join(',')} matched none of: ${cases.map((c) => c.id).join(', ')}`)

let bad = 0
let total = 0
const noInteractive = []
for (const c of targets) {
  const oldShots = await shots(c.id, SIDE_A)
  const newShots = await shots(c.id, SIDE_B)
  if (!oldShots.length) {
    noInteractive.push(c.id)
    console.log(`skip  ${c.id.padEnd(16)} no interactive elements on this case`)
    continue
  }
  for (let k = 0; k < oldShots.length; k++) {
    const o = oldShots[k]
    const r = await compare(o.png, newShots[k].png)
    const ok = !r.sizeMismatch && r.differing === 0
    total++
    if (!ok) bad++
    console.log(
      `${(ok ? 'ok' : 'DIFF').padEnd(5)} ${c.id.padEnd(16)} ${String(o.i).padStart(2)} ${o.state.padEnd(14)} ${o.label} ` +
        (ok ? '' : `→ ${r.differing}px worst ${r.worst}` + (r.box ? ` box ${r.box.join(',')}` : ''))
    )
  }
}
console.log(
  `\n${total - bad}/${total} state bitmaps identical across ${targets.length - noInteractive.length} of ` +
    `${targets.length} case(s) · ${bad} differing` +
    (noInteractive.length ? `\nno interactive elements, not measured: ${noInteractive.join(', ')}` : '')
)
await browser.close()
if (bad || noInteractive.length === targets.length) process.exitCode = 1
