import { chromium } from 'playwright'
import { prep } from './prep.mjs'
import { captureStage } from './capture.mjs'
import { assertOldSideFresh } from './freshness.mjs'

assertOldSideFresh()

const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8931/?freeze'
const THEME = process.env.THEME || 'graphite'
const MOTION = process.env.MOTION || 'no-preference'
const CONTROL = process.env.CONTROL
const SIDE_A = CONTROL || 'old'
const SIDE_B = CONTROL || 'new'

const IGNORE = new Set([
  'transform',
  'scale',
  'translate',
  'boxShadow',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'outlineColor',
  'outlineWidth',
  'transitionProperty',
  'transitionDuration',
  'transitionTimingFunction',
  'transitionDelay',
  'transitionBehavior',
  'animationName',
  'animationDuration',
  'animationTimingFunction',
  'animationIterationCount',
  'animationFillMode',
  'animationDirection',
  'animationDelay',
  'animationPlayState',
  'animationComposition',
  'animationRange',
  'animationRangeStart',
  'animationRangeEnd',
  'animationTimeline',
  'webkitTransform',
  'webkitTransition',
  'webkitAnimation',
  'webkitAnimationName',
  'webkitTextFillColor',
  'blockSize',
  'inlineSize',
  'perspectiveOrigin',
  'transformOrigin',
  'borderBlockStartColor',
  'borderBlockEndColor',
  'borderInlineStartColor',
  'borderInlineEndColor',
  'borderBlockStartStyle',
  'borderBlockEndStyle',
  'borderInlineStartStyle',
  'borderInlineEndStyle',
  'borderTopStyle',
  'borderRightStyle',
  'borderBottomStyle',
  'borderLeftStyle',
  'rotate'
])

function norm(prop, v) {
  const m = v.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/)
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => Math.round(parseFloat(x) * 255))
    const a = m[4] === undefined ? 1 : parseFloat(m[4])
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`
  }
  const DIRS = { 'to top': '0deg', 'to right': '90deg', 'to bottom': '180deg', 'to left': '270deg' }
  if (/gradient\(/.test(v))
    return v.replace(/\((to (?:top|right|bottom|left)),/g, (_, d) => `(${DIRS[d]},`)
  if (/radius/.test(prop)) {
    const px = parseFloat(v)
    if (!Number.isNaN(px) && px >= 500) return 'PILL'
  }
  return v
}

const activeAsserts = (c) => (c.assert ?? []).filter((a) => !a.motion || a.motion === MOTION)

async function checkAsserts(page, asserts, side, id) {
  if (!asserts || !asserts.length) return []
  const rows = await page.evaluate((as) => {
    const stage = document.querySelector('[data-stage]')
    const freeze = document.getElementById('harness-freeze')
    const needsThaw = as.some((a) => a.unfrozen)
    if (needsThaw && freeze) freeze.disabled = true
    try {
      return as.map((a) => {
        const els = stage ? [...stage.querySelectorAll(a.sel)] : []
        return {
          ...a,
          n: els.length,
          actual: els.map((e) => getComputedStyle(e).getPropertyValue(a.prop)),
        }
      })
    } finally {
      if (needsThaw && freeze) freeze.disabled = false
    }
  }, asserts)
  const fails = []
  for (const r of rows) {
    if (r.n === 0) {
      fails.push(`case ${id} (${side}): assert selector '${r.sel}' matched 0 elements in the stage`)
      continue
    }
    for (const [i, v] of r.actual.entries()) {
      if (v !== r.is)
        fails.push(
          `case ${id} (${side}): ${r.sel}[${i}] ${r.prop} is '${v}', required '${r.is}'`,
        )
    }
  }
  return fails
}

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 2400, height: 1200 } })
await page.emulateMedia({ reducedMotion: MOTION })
await page.goto(URL, { waitUntil: 'networkidle' })
await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), THEME)
await page.waitForFunction(() => typeof window.__setView === 'function')

const cases = await page.evaluate(() => window.__cases)

if (!cases || cases.length === 0) {
  console.error('FAIL: window.__cases is missing or empty — nothing to measure.')
  await browser.close()
  process.exit(1)
}

async function captureSide(c, side) {
  await page.evaluate(([id, s]) => window.__setView(id, s, true), [c.id, side])
  await page.waitForTimeout(60)
  if (c.prep && c.prep.length) {
    const r = await prep(page, c.prep)
    if (!r.ok) throw new Error(`case ${c.id} (${side}): prep step failed — ${r.why}`)
    await page.waitForTimeout(140)
  }
  assertFails.push(...(await checkAsserts(page, activeAsserts(c), side, c.id)))
  return captureStage(page, [...IGNORE])
}

const assertFails = []

const report = []
const coverageErrors = []
let nodesWalked = 0

function walk(id, a, b, path) {
  nodesWalked++
  if (!a || !b) {
    report.push({ id, path, kind: 'structure', detail: `${a ? SIDE_B : SIDE_A} side missing node` })
    return
  }
  if (a.tag !== b.tag) {
    report.push({ id, path, kind: 'structure', detail: `${a.tag} vs ${b.tag}` })
    return
  }
  const props = new Set([...Object.keys(a.style), ...Object.keys(b.style)])
  for (const prop of props) {
    const va = norm(prop, a.style[prop] ?? '')
    const vb = norm(prop, b.style[prop] ?? '')
    if (va !== vb) report.push({ id, path, prop, old: va, new: vb })
  }
  if (a.box.join() !== b.box.join())
    report.push({ id, path, prop: 'BOX x,y,w,h', old: a.box.join(), new: b.box.join() })
  const an = a.children
  const bn = b.children
  const n = Math.max(an.length, bn.length)
  for (let i = 0; i < n; i++)
    walk(id, an[i], bn[i], `${path}>${an[i]?.tag || bn[i]?.tag || '?'}[${i}]`)
}

const ONLY = process.env.CASE ? process.env.CASE.split(',') : null
if (ONLY) {
  const unknown = ONLY.filter((id) => !cases.some((c) => c.id === id))
  if (unknown.length) throw new Error(`CASE=${unknown.join(',')} matched no case`)
  console.log(`NARROWED to ${ONLY.join(', ')} — diagnostic run, not a verdict`)
}

for (const c of ONLY ? cases.filter((x) => ONLY.includes(x.id)) : cases) {
  const treeA = await captureSide(c, SIDE_A)
  const treeB = await captureSide(c, SIDE_B)
  if (!treeA || !treeB) {
    coverageErrors.push(
      `case ${c.id}: zero element nodes on the ${!treeA ? SIDE_A : SIDE_B} side — nothing was measured.`
    )
    continue
  }
  walk(c.id, treeA, treeB, 'root')
}

if (nodesWalked === 0) {
  console.error('FAIL: 0 nodes walked across the whole run — the harness measured nothing.')
  for (const e of coverageErrors) console.error(`  ${e}`)
  await browser.close()
  process.exit(1)
}

const byCase = new Map()
for (const r of report) {
  if (!byCase.has(r.id)) byCase.set(r.id, [])
  byCase.get(r.id).push(r)
}
let total = 0
for (const [id, rows] of byCase) {
  console.log(`\n### ${id} — ${rows.length}`)
  const seen = new Set()
  for (const r of rows) {
    const key = `${r.prop || r.kind}|${r.old}|${r.new}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`  ${r.path}\n    ${r.prop || r.kind}: ${r.old}  ->  ${r.new}`)
  }
  total += rows.length
}
console.log(`\ntotal diffs: ${total} across ${byCase.size} cases`)
const ran = ONLY ? ONLY.length : cases.length
console.log(`coverage: ${ran} cases, ${nodesWalked} nodes compared (${SIDE_A} vs ${SIDE_B})`)
const assertsDeclared = cases.reduce((n, c) => n + activeAsserts(c).length, 0)
const assertsGated = cases.reduce((n, c) => n + (c.assert?.length ?? 0), 0) - assertsDeclared
console.log(
  `asserts: ${assertsDeclared} active, ${assertFails.length} failing` +
    (assertsGated ? ` (${assertsGated} gated out at MOTION=${MOTION})` : ''),
)
if (!assertsDeclared) {
  console.log(
    assertsGated
      ? `  ↑ NO INVARIANTS EXERCISED — all ${assertsGated} are gated out at MOTION=${MOTION}. Re-run at the motion setting they declare.`
      : '  ↑ NO INVARIANTS EXERCISED — no case declares an `assert`. This run proves nothing beyond old-vs-new equality.',
  )
}
if (assertFails.length) {
  console.error('\nFAIL: invariants —')
  for (const e of assertFails) console.error(`  ${e}`)
}
if (coverageErrors.length) {
  console.error('\nFAIL: coverage gaps —')
  for (const e of coverageErrors) console.error(`  ${e}`)
}
await browser.close()
if (total > 0 || coverageErrors.length > 0 || assertFails.length > 0) process.exitCode = 1
