import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const IS_CLI = import.meta.url === `file://${process.argv[1]}`
const target = process.argv[2]
if (IS_CLI && !target) {
  console.error('usage: node census.mjs <ComponentName>   (e.g. SessionPane)')
  process.exit(2)
}

const SRC = 'src/renderer/src'
// styles.css was deleted from the tree; this reads the pinned pre-deletion
// copy (kept in sync with the tag by freshness.mjs) since there is no live
// file left to census against.
const CSS = 'p5-harness/old-full.css'

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
const files = walk(SRC).filter((p) => !isTest(p))

const sources = new Map(files.map((p) => [p, readFileSync(p, 'utf8')]))

const blank = (s) => s.replace(/[^\n]/g, ' ')
const stripComments = (t) =>
  t.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/@[a-z-]+[^;{}\n]*;/gi, blank)

function blocks(text, base = 0) {
  const lines = text.split('\n')
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    const o = (lines[i].match(/\{/g) || []).length
    const c = (lines[i].match(/\}/g) || []).length
    if (depth === 0 && o > 0) {
      start = i
      while (start > 0 && lines[start - 1].trimEnd().endsWith(',')) start--
    }
    const prev = depth
    depth += o - c
    if (depth === 0 && (prev > 0 || o > 0)) out.push({ text: lines.slice(start, i + 1).join('\n'), line: base + start + 1 })
  }
  return out
}

const GROUPING = /^@(media|supports|layer|container|scope)\b/

function leaves(bs, ctx = []) {
  const out = []
  for (const b of bs) {
    const head = b.text.slice(0, b.text.indexOf('{')).trim()
    const body = b.text.slice(b.text.indexOf('{') + 1, b.text.lastIndexOf('}'))
    if (head.startsWith('@')) {
      if (GROUPING.test(head)) {
        const headLines = b.text.slice(0, b.text.indexOf('{')).split('\n').length
        out.push(...leaves(blocks(body, b.line + headLines - 1), [...ctx, head]))
      }
      continue
    }
    out.push({ head, line: b.line, ctx })
  }
  return out
}

// Collects both literal class tokens and interpolation STEMS (the partial
// token right before a `${`): a class written only as `` `u-${level}` `` has
// no literal match anywhere, so missing the stem reports its rule DEAD.
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
const tokens = new Map([...sources].map(([p, t]) => [p, tokensOf(stripJs(t))]))

function classNameTokens(src) {
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
  for (const m of src.matchAll(/\bclassName\s*=\s*/g)) {
    const i = m.index + m[0].length
    if (src[i] === '"' || src[i] === "'") {
      const end = src.indexOf(src[i], i + 1)
      if (end > 0) add(src.slice(i + 1, end))
      continue
    }
    if (src[i] !== '{') continue
    let depth = 0
    let j = i
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}' && --depth === 0) break
    }
    scan(src.slice(i + 1, j))
  }
  return { toks, stems }
}

const ownTokens = new Map([...sources].map(([p, t]) => [p, classNameTokens(t)]))

function compoundsOf(head) {
  const out = []
  for (const sel of head.split(',')) {
    let buf = ''
    let depth = 0
    for (const ch of sel) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~' || ch === '\n')) {
        if (buf.trim()) out.push(buf.trim())
        buf = ''
        continue
      }
      buf += ch
    }
    if (buf.trim()) out.push(buf.trim())
  }
  return out
}

const RUNTIME_DOM = [
  { re: /^xterm(-|$)/, why: 'xterm.js generates this element; no className can be added to it' },
]
const runtimeDom = (classes) =>
  classes.map((c) => RUNTIME_DOM.find((r) => r.re.test(c))).find(Boolean)

const consumerCache = new Map()
function consumers(cls) {
  if (!consumerCache.has(cls)) {
    consumerCache.set(
      cls,
      [...tokens]
        .filter(
          ([, t]) =>
            t.toks.has(cls) ||
            [...t.stems].some((st) => cls.startsWith(st) && cls.length > st.length),
        )
        .map(([p]) => p),
    )
  }
  return consumerCache.get(cls)
}

const css = readFileSync(CSS, 'utf8')
const rules = leaves(blocks(stripComments(css)))

const owned = []
const shared = []
const dead = []
const runtime = []

for (const r of rules) {
  const classes = [...new Set([...r.head.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))]
  if (!classes.length) continue

  const rt = runtimeDom(classes)
  if (rt) {
    runtime.push({ ...r, classes, why: rt.why })
    continue
  }

  // Consumers are resolved per compound (`button.tl.close` needs one element
  // carrying both classes), then unioned across compounds — a per-class union
  // would treat any file using either class alone as a consumer of the rule.
  const compoundClasses = compoundsOf(r.head).map((c) =>
    [...new Set([...c.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))],
  )
  const all = [
    ...new Set(
      compoundClasses
        .filter((cs) => cs.length)
        .flatMap((cs) => cs.map(consumers).reduce((a, b) => a.filter((p) => b.includes(p)))),
    ),
  ]
  if (!all.length) {
    dead.push({ ...r, classes })
    continue
  }
  const mine = all.filter((p) => p.includes(`/${target}.`) || p.endsWith(`/${target}.tsx`))
  const others = all.filter((p) => !mine.includes(p))
  const present = (c) => {
    for (const p of mine) {
      const { toks, stems } = ownTokens.get(p)
      if (toks.has(c)) return true
      for (const st of stems) if (c.startsWith(st) && c.length > st.length) return true
    }
    return false
  }
  // A class must appear in a className position to count as ownership, not
  // just anywhere in the target's tokens — a usage level string like 'ok' or
  // a `res.ok` property access is not a class the component ever renders.
  const inMyMarkup = classes.every(present)
  if (mine.length && !others.length && inMyMarkup) owned.push({ ...r, classes })
  else if (mine.length && !others.length) dead.push({ ...r, classes, note: 'target matched on a non-className string only' })
  else if (mine.length) shared.push({ ...r, classes, others: [...new Set(others)] })
}

export { tokensOf, classNameTokens, compoundsOf, leaves, blocks, stripComments, runtimeDom, SRC, CSS, files, sources }

if (IS_CLI) {
  const fmt = (r) => `  styles.css:${String(r.line).padStart(4)}  ${r.ctx.length ? `[${r.ctx.join(' ')}] ` : ''}${r.head.replace(/\s+/g, ' ')}`

  console.log(`OWNED by ${target} (${owned.length} blocks) — the shard's scope`)
  for (const r of owned) console.log(fmt(r))
  console.log(`\nSHARED (${shared.length} blocks) — OUT of shard, rule 8`)
  for (const r of shared) console.log(`${fmt(r)}\n        also: ${r.others.map((p) => p.split('/').pop()).join(', ')}`)
  console.log(`\nDEAD (${dead.length} blocks) — no consumer found; prove before deleting`)
  for (const r of dead) console.log(`${fmt(r)}${r.note ? `\n        note: ${r.note}` : ""}`)
  console.log(
    `\nRUNTIME DOM (${runtime.length} blocks) — NOT dead, NOT convertible, never in a shard`,
  )
  for (const r of runtime) console.log(`${fmt(r)}\n        ${r.why}`)
}
