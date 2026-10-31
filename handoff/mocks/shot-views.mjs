// Usage: node shot-views.mjs <mock.html> <outDir> <viewRegex> [width=1280] [height=800]
// Captures every matching data-view in both themes as <outDir>/<view>-<theme>.png and fails on page errors.
import { createRequire } from 'node:module'
const require = createRequire('/home/theo/ProjetosPessoais/Houston/.houston/worktrees/design-native/ui/package.json')
const { chromium } = require('playwright')
const [file, out, pattern = '.', w = '1280', h = '800'] = process.argv.slice(2)
const fs = await import('node:fs'); fs.mkdirSync(out, { recursive: true })
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' })
const p = await b.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 })
const errs = []; p.on('pageerror', (e) => errs.push(e.message))
await p.goto('file://' + file); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400)
const views = (await p.$$eval('section.view[data-view]', (s) => s.map((x) => x.dataset.view))).filter((v) => new RegExp(pattern).test(v))
for (const v of views) for (const t of ['graphite', 'paper']) {
  await p.evaluate(([v, t]) => { setTheme(t); go(v) }, [v, t]); await p.waitForTimeout(120)
  await p.screenshot({ path: `${out}/${v}-${t}.png` })
}
console.log(`shots: ${views.length} views x 2 themes in ${out}`); if (errs.length) { console.error('page errors:', errs); process.exitCode = 1 }
await b.close()
