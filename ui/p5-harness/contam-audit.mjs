import { execFileSync } from 'node:child_process'

const git = (...a) => {
  try {
    return execFileSync('git', a, {
      cwd: '/home/dev/projects/houston',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString()
  } catch {
    return null
  }
}

const SHARDS = [
  ['244e70b', 'shard 1  modals + small leaves'],
  ['7fc80a5', 'shard 2  memory'],
  ['1f9870e', 'shard 3  swarm leaves'],
  ['5467ea6', 'shard 3b AgentChip'],
  ['89da2ee', 'shard 4a swarm header/chrome'],
  ['a17d1fe', 'shard 4b zoom coupling'],
  ['886bc93', 'shard 4c SwarmBuilder'],
  ['16b284e', 'shard 4c fixups'],
  ['d8162b2', 'shard 4d shared swarm primitives'],
  ['0dada2a', 'shard 4e swarm finish'],
  ['b9b14dc', 'shard 5  git family'],
  ['749c8f0', 'shard 6  setup family'],
  ['543d458', 'shard 7  launcher'],
  ['d78198e', 'shard 8  set-'],
  ['cd17beb', 'shard 9  rpanel/rtab/rbrowser/skills'],
  ['7e6206b', 'shard 10 board'],
  ['2a4898d', 'shard 11 sidebar']
]

const cssAt = (ref) =>
  (git('ls-tree', '-r', '--name-only', ref, 'ui/src/renderer/') || '')
    .split('\n')
    .filter((f) => f.endsWith('.css'))

function topLevel(css) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
      continue
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < css.length; i++) {
        if (css[i] === '\\') i++
        else if (css[i] === ch) break
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        out.push(css.slice(start, i + 1))
        start = i + 1
      }
    }
  }
  return out
}

function heads(css, prefix = '') {
  const out = new Map()
  for (const block of topLevel(css)) {
    const b = block.indexOf('{')
    if (b === -1) continue
    const head = block
      .slice(0, b)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .pop()
      .trim()
      .replace(/\s+/g, ' ')
    if (!head) continue
    if (/^@(keyframes|font-face|property)\b/.test(head)) {
      out.set(prefix + head, block)
    } else if (/^@(layer|media|supports|container)\b/.test(head)) {
      const body = block.slice(b + 1, block.lastIndexOf('}'))
      const inner = heads(body, /^@layer\b/.test(head) ? prefix : `${prefix}${head} >> `)
      for (const [k, v] of inner) out.set(k, v)
    } else {
      out.set(prefix + head, block)
    }
  }
  return out
}

function classesOf(head) {
  const sel = head.split(' >> ').pop()
  if (sel.startsWith('@')) return []
  return [...new Set([...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))]
}

function markupTokensAt(ref) {
  const files = (git('ls-tree', '-r', '--name-only', ref, 'ui/src/renderer/src/') || '')
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
  const toks = new Set()
  const add = (body) => {
    for (const t of body.split(/\s+/)) if (/^-?[_a-zA-Z][\w-]*$/.test(t)) toks.add(t)
  }
  const scan = (src) => {
    for (const m of src.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
      if (m[3] === undefined) {
        add(m[1] ?? m[2] ?? '')
        continue
      }
      const body = m[3]
      add(body.replace(/\$\{[\s\S]*?\}/g, ' '))
      for (const interp of body.matchAll(/\$\{([\s\S]*?)\}/g)) scan(interp[1])
    }
  }
  for (const f of files) scan(git('show', `${ref}:${f}`) || '')
  return toks
}

let anyHits = 0
const summary = []
for (const [ref, label] of SHARDS) {
  const files = [...new Set([...cssAt(`${ref}^`), ...cssAt(ref)])]
  const before = files.map((f) => git('show', `${ref}^:${f}`) || '').join('\n')
  const after = files.map((f) => git('show', `${ref}:${f}`) || '').join('\n')
  const hb = heads(before)
  const ha = heads(after)
  const deleted = [...hb.keys()].filter((h) => !ha.has(h))
  const toks = markupTokensAt(ref)
  const live = deleted.filter((h) => {
    const cs = classesOf(h)
    return cs.length > 0 && cs.every((c) => toks.has(c))
  })
  console.log(`\n=== ${label}  (${ref})  deleted ${deleted.length} blocks`)
  if (!live.length) {
    console.log('    CLEAN — every deleted selector has at least one class absent from the converted markup')
  } else {
    anyHits += live.length
    for (const h of live) console.log(`    LIVE  ${h}`)
  }
  summary.push([label, deleted.length, live.length])
}
console.log('\n--- summary ---')
for (const [l, d, v] of summary) console.log(`${String(v).padStart(3)} live / ${String(d).padStart(4)} deleted   ${l}`)
console.log(`\nTOTAL live deleted selectors: ${anyHits}`)
