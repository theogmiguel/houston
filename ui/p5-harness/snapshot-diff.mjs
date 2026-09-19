import { readFileSync, existsSync } from 'node:fs'
import { chromium } from 'playwright'

const [before, after] = process.argv.slice(2)
if (!before || !after) {
  console.error('usage: node p5-harness/snapshot-diff.mjs <before-dir> <after-dir>')
  process.exit(2)
}

const EXPECTED = {
  'box-sizing': '§3c: box-sizing: border-box globally',
  'margin-top': '§3c: margin 0 on headings, paragraphs, lists',
  'margin-bottom': '§3c: margin 0 on headings, paragraphs, lists',
  'margin-left': '§3c: margin 0 on headings, paragraphs, lists',
  'margin-right': '§3c: margin 0 on headings, paragraphs, lists',
  'margin-block-start': '§3c: margin 0 on headings, paragraphs, lists',
  'margin-block-end': '§3c: margin 0 on headings, paragraphs, lists',
  'margin-inline-start': '§3c: margin 0 on headings, paragraphs, lists',
  'margin-inline-end': '§3c: margin 0 on headings, paragraphs, lists',
  'padding-inline-start': '§3c: list markers removed (UA list padding goes with them)',
  'list-style-type': '§3c: list markers removed',
  'list-style-position': '§3c: list markers removed',
  'list-style-image': '§3c: list markers removed',
  'border-top-width': '§3c: border: 0 solid on everything',
  'border-right-width': '§3c: border: 0 solid on everything',
  'border-bottom-width': '§3c: border: 0 solid on everything',
  'border-left-width': '§3c: border: 0 solid on everything',
  'border-top-style': '§3c: border: 0 solid on everything',
  'border-right-style': '§3c: border: 0 solid on everything',
  'border-bottom-style': '§3c: border: 0 solid on everything',
  'border-left-style': '§3c: border: 0 solid on everything',
  'border-top-color': '§3c: border: 0 solid on everything',
  'border-right-color': '§3c: border: 0 solid on everything',
  'border-bottom-color': '§3c: border: 0 solid on everything',
  'border-left-color': '§3c: border: 0 solid on everything',
  'border-block-start-width': '§3c: border: 0 solid (logical alias)',
  'border-block-end-width': '§3c: border: 0 solid (logical alias)',
  'border-inline-start-width': '§3c: border: 0 solid (logical alias)',
  'border-inline-end-width': '§3c: border: 0 solid (logical alias)',
  'border-block-start-style': '§3c: border: 0 solid (logical alias)',
  'border-block-end-style': '§3c: border: 0 solid (logical alias)',
  'border-inline-start-style': '§3c: border: 0 solid (logical alias)',
  'border-inline-end-style': '§3c: border: 0 solid (logical alias)',
  'border-block-start-color': '§3c: border: 0 solid (logical alias)',
  'border-block-end-color': '§3c: border: 0 solid (logical alias)',
  'border-inline-start-color': '§3c: border: 0 solid (logical alias)',
  'border-inline-end-color': '§3c: border: 0 solid (logical alias)',
  display: '§3c: img/svg become display: block',
  'font-family': '§3c: form controls inherit font instead of the UA font',
  'font-size': '§3c: form controls inherit font instead of the UA font',
  'font-weight': '§3c: form controls inherit font instead of the UA font',
  'font-style': '§3c: form controls inherit font instead of the UA font',
  'letter-spacing': '§3c: form controls inherit font instead of the UA font',
  appearance: '§3c: button loses its UA appearance',
  '-webkit-appearance': '§3c: button loses its UA appearance',
  'background-color': '§3c: button loses its UA appearance (UA button background)',
  'text-transform': '§3c: form controls inherit typography instead of the UA font',
  'text-indent': '§3c: form controls lose UA text-indent',
  cursor: '§3c: button loses its UA appearance'
}

const walk = (node, path, out) => {
  if (!node) return
  out.push([path, node])
  node.children.forEach((ch, i) => walk(ch, `${path}>${ch.tag}[${i}]`, out))
}

const manifest = JSON.parse(readFileSync(`${before}/manifest.json`, 'utf8'))
const byProp = new Map()
let structural = 0
let nodesCompared = 0
const pixelJobs = []
const pixelRows = []

for (const id of manifest.cases) {
  const A = []
  const B = []
  walk(JSON.parse(readFileSync(`${before}/${id}.json`, 'utf8')), 'root', A)
  const bPath = `${after}/${id}.json`
  if (!existsSync(bPath)) {
    console.error(`case ${id}: missing from ${after} — the two runs do not cover the same cases`)
    process.exitCode = 1
    continue
  }
  walk(JSON.parse(readFileSync(bPath, 'utf8')), 'root', B)
  if (A.length !== B.length) {
    structural++
    console.log(`STRUCTURE ${id}: ${A.length} nodes before, ${B.length} after`)
  }
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const [path, a] = A[i]
    const b = B[i][1]
    nodesCompared++
    for (const [k, axis] of [[0, 'x'], [1, 'y'], [2, 'w'], [3, 'h']]) {
      if (a.box[k] !== b.box[k]) {
        const key = `box.${axis}`
        if (!byProp.has(key)) byProp.set(key, [])
        byProp.get(key).push({ id, path, from: a.box[k], to: b.box[k] })
      }
    }
    for (const prop of new Set([...Object.keys(a.style), ...Object.keys(b.style)])) {
      const va = a.style[prop] ?? ''
      const vb = b.style[prop] ?? ''
      if (va === vb) continue
      if (!byProp.has(prop)) byProp.set(prop, [])
      byProp.get(prop).push({ id, path, from: va, to: vb })
    }
  }

  const pa = `${before}/${id}.png`
  const pb = `${after}/${id}.png`
  if (existsSync(pa) && existsSync(pb)) {
    pixelJobs.push({ id, a: readFileSync(pa).toString('base64'), b: readFileSync(pb).toString('base64') })
  }
}

if (pixelJobs.length) {
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage()
  await page.goto('about:blank')
  for (const job of pixelJobs) {
    pixelRows.push({
      id: job.id,
      ...(await page.evaluate(async ([A, B]) => {
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
        if (p.w !== q.w || p.h !== q.h) return { sizeMismatch: [p.w, p.h, q.w, q.h] }
        let n = 0
        let worst = 0
        for (let i = 0; i < p.d.length; i += 4) {
          let d = 0
          for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(p.d[i + k] - q.d[i + k]))
          if (d > 0) {
            n++
            if (d > worst) worst = d
          }
        }
        return { differing: n, worst, pixels: p.w * p.h }
      }, [job.a, job.b]))
    })
  }
  await browser.close()
}

const rows = [...byProp.entries()].sort((x, y) => y[1].length - x[1].length)
const unexpected = rows.filter(([p]) => !(p in EXPECTED) && !p.startsWith('box.'))

console.log(`\n=== computed-style deltas (${nodesCompared} nodes compared, ${structural} structural) ===\n`)
for (const [prop, hits] of rows) {
  const tag = prop.startsWith('box.') ? 'GEOMETRY' : prop in EXPECTED ? 'expected' : 'UNEXPECTED'
  const note = EXPECTED[prop] ? `  — ${EXPECTED[prop]}` : ''
  const sample = hits[0]
  console.log(
    `${tag.padEnd(10)} ${prop.padEnd(28)} ${String(hits.length).padStart(5)} node(s)${note}\n` +
      `           e.g. ${sample.id} ${sample.path}: '${sample.from}' -> '${sample.to}'`
  )
}

console.log(`\n=== bitmaps ===\n`)
for (const r of pixelRows) {
  if (r.sizeMismatch) console.log(`SIZE  ${r.id.padEnd(24)} ${r.sizeMismatch.join('x')}`)
  else
    console.log(
      `${(r.differing ? 'DIFF' : 'ok').padEnd(5)} ${r.id.padEnd(24)} ${String(r.differing).padStart(8)} px ` +
        `(${((r.differing / r.pixels) * 100).toFixed(2)}%) worst ${r.worst}`
    )
}

const changedCases = pixelRows.filter((r) => r.sizeMismatch || r.differing).length
console.log(
  `\n${rows.length} properties changed on some node · ${unexpected.length} NOT named by §3c · ` +
    `${changedCases}/${pixelRows.length} cases differ visually`
)
if (unexpected.length) {
  console.log(`\nUNEXPECTED properties (each needs an explanation before this ships):`)
  for (const [p, hits] of unexpected) console.log(`  ${p} (${hits.length})`)
}
