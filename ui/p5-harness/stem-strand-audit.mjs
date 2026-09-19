import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src/renderer/src'
const CSS = 'p5-harness/old-full.css'
const REPO = execSync('git rev-parse --show-toplevel').toString().trim()

const BASE = process.env.BASE || 'HEAD~40'
if (!/^[\w.~^/-]+$/.test(BASE)) throw new Error(`BASE is not a plausible git rev: ${BASE}`)
const baseCss = execSync(`git show ${BASE}:ui/${CSS}`, { cwd: REPO, maxBuffer: 1 << 28 }).toString()
const nowCss = readFileSync(CSS, 'utf8')

const classesIn = (t) =>
  new Set([...t.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))

const blank = (s) => s.replace(/[^\n]/g, ' ')
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, blank)

const before = classesIn(strip(baseCss))
const after = classesIn(strip(nowCss))
const deleted = [...before].filter((c) => !after.has(c))

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p)
  }
  return out
}
const isTest = (p) => /\.test\.tsx?$/.test(p) || p.includes('__tests__')
const files = walk(SRC).filter((p) => !isTest(p) && !p.includes('p5-harness'))

function tokensOf(src) {
  const toks = new Set()
  const stems = new Set()
  const add = (body) => {
    for (const t of body.split(/\s+/)) if (/^-?[_a-zA-Z][\w-]*$/.test(t)) toks.add(t)
  }
  const scan = (s) => {
    for (const m of s.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
      if (m[3] === undefined) {
        add(m[1] ?? m[2] ?? '')
        continue
      }
      for (const seg of m[3].split(/\$\{[\s\S]*?\}/).slice(0, -1)) {
        const stem = seg.split(/\s/).pop()
        if (/^[_a-zA-Z][\w-]*[-_]$/.test(stem)) stems.add(stem)
      }
      add(m[3].replace(/\$\{[\s\S]*?\}/g, ' '))
      for (const i of m[3].matchAll(/\$\{([\s\S]*?)\}/g)) scan(i[1])
    }
  }
  scan(src)
  return { toks, stems }
}
const stripJs = (t) =>
  t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const tokens = new Map(files.map((p) => [p, tokensOf(stripJs(readFileSync(p, 'utf8')))]))

const rows = []
for (const cls of deleted) {
  const literal = []
  const stemOnly = []
  for (const [p, t] of tokens) {
    if (t.toks.has(cls)) literal.push(p)
    else if ([...t.stems].some((st) => cls.startsWith(st) && cls.length > st.length))
      stemOnly.push(p)
  }
  if (!stemOnly.length) continue
  rows.push({ cls, literal, stemOnly })
}

console.log(`baseline ${BASE}: ${before.size} classes styled, ${after.size} now, ${deleted.length} deleted\n`)
if (!rows.length) {
  console.log('CLEAN — no deleted class has a stem-only consumer. The hole could not have')
  console.log('mis-scoped any shard that has already landed.')
  process.exit(0)
}
console.log(`${rows.length} deleted class(es) HAVE a stem-only consumer — adjudicate each:\n`)
for (const r of rows) {
  const all = [...new Set([...r.literal, ...r.stemOnly])]
  const verdict = all.length > 1 ? 'MULTI-CONSUMER — likely stranding' : 'single consumer'
  console.log(`  .${r.cls}  [${verdict}]`)
  for (const p of r.stemOnly) console.log(`      stem-only: ${p}`)
  for (const p of r.literal) console.log(`      literal:   ${p}`)
}
process.exitCode = rows.some((r) => new Set([...r.literal, ...r.stemOnly]).size > 1) ? 1 : 0
