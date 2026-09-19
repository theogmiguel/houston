import { readFileSync } from 'node:fs'
import {
  classNameTokens,
  compoundsOf,
  leaves,
  blocks,
  stripComments,
  runtimeDom,
  CSS,
  sources,
} from './census.mjs'

const strict = new Map([...sources].map(([p, t]) => [p, classNameTokens(t)]))

const consumerCache = new Map()
function strictConsumers(cls) {
  if (!consumerCache.has(cls)) {
    consumerCache.set(
      cls,
      [...strict]
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

const classesOf = (s) => [...new Set([...s.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))]

const rules = leaves(blocks(stripComments(readFileSync(CSS, 'utf8'))))
const unlayered = rules.filter((r) => !r.ctx.some((c) => c.startsWith('@layer')))

const single = []
const shared = []
const none = []
const runtime = []

for (const r of unlayered) {
  const classes = classesOf(r.head)
  if (!classes.length) continue
  const rt = runtimeDom(classes)
  if (rt) {
    runtime.push({ ...r, why: rt.why })
    continue
  }
  const perCompound = compoundsOf(r.head)
    .map(classesOf)
    .filter((cs) => cs.length)
    .map((cs) => cs.map(strictConsumers).reduce((a, b) => a.filter((p) => b.includes(p))))
  const all = [...new Set(perCompound.flat())]
  if (!all.length) none.push({ ...r, classes })
  else if (all.length === 1) single.push({ ...r, owner: all[0] })
  else shared.push({ ...r, owners: all })
}

const fmt = (r) =>
  `  styles.css:${String(r.line).padStart(4)}  ${r.ctx.length ? `[${r.ctx.join(' ')}] ` : ''}${r.head.replace(/\s+/g, ' ').slice(0, 76)}`
const base = (p) => p.split('/').pop()

console.log(`SINGLE consumer (${single.length}) — convertible, not layer material`)
const byOwner = new Map()
for (const r of single) {
  if (!byOwner.has(r.owner)) byOwner.set(r.owner, [])
  byOwner.get(r.owner).push(r)
}
for (const [owner, rs] of [...byOwner].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${base(owner)}  (${rs.length})`)
  for (const r of rs) console.log(fmt(r))
}

console.log(`\n\nSHARED (${shared.length}) — layer these`)
for (const r of shared) console.log(`${fmt(r)}\n        ${r.owners.map(base).join(', ')}`)

console.log(`\n\nNO CLASSNAME MATCH (${none.length}) — prove before doing anything`)
for (const r of none) console.log(fmt(r))

if (runtime.length) {
  console.log(`\n\nRUNTIME DOM (${runtime.length}) — never convertible, never in a shard`)
  for (const r of runtime) console.log(fmt(r))
}

console.log(
  `\n\ntotals: ${single.length} single · ${shared.length} shared · ${none.length} unproven · ${runtime.length} runtime` +
    `  (of ${unlayered.filter((r) => classesOf(r.head).length).length} unlayered class rules)`,
)
