import { execFileSync } from 'node:child_process'

const SHARDS = [
  ['1', '244e70b'],
  ['2', '7fc80a5'],
  ['3', '1f9870e'],
  ['3b', '5467ea6'],
  ['4a', '89da2ee'],
  ['4b', 'a17d1fe'],
  ['4c', '886bc93'],
  ['4d', 'd8162b2'],
  ['4e', '0dada2a'],
  ['5', 'b9b14dc'],
  ['6', '749c8f0'],
  ['7', '543d458'],
  ['8', 'd78198e'],
  ['9', 'cd17beb'],
  ['10', '7e6206b'],
  ['11', '2a4898d'],
]

const FILES = [
  'ui/src/renderer/src/styles.css',
  'ui/src/renderer/src/theme.css',
  'ui/src/renderer/src/base.css',
  'ui/src/renderer/src/global.css',
  'ui/src/renderer/src/components/swarm/swarm.css',
  'ui/src/renderer/src/components/memory/memory.css',
]

function show(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
  } catch {
    return null
  }
}

function changedCss(commit) {
  const out = execFileSync('git', ['show', '--name-only', '--format=', commit], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('ui/src/') && s.endsWith('.css') && !s.endsWith('tailwind.css'))
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@[a-z-]+[^;{}]*;/gi, '')
}

function blocks(text) {
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
    if (depth === 0 && (prev > 0 || o > 0)) out.push(lines.slice(start, i + 1).join('\n'))
  }
  return out
}

const GROUPING = /^@(media|supports|layer|container|scope)\b/

function flatBlocks(text, prefix = []) {
  const out = []
  for (const b of blocks(text)) {
    const head = b.slice(0, b.indexOf('{')).trim()
    const body = b.slice(b.indexOf('{') + 1, b.lastIndexOf('}'))
    if (head.startsWith('@')) {
      if (GROUPING.test(head)) {
        const carry = head.startsWith('@layer') ? prefix : [...prefix, norm(head)]
        out.push(...flatBlocks(body, carry))
      }
      else out.push({ head, sels: [], text: `${prefix.join('|')}|${norm(head)}{${norm(body)}}` })
      continue
    }
    out.push({
      head,
      sels: head.split(',').map((s) => norm(s)).filter(Boolean),
      text: `${prefix.join('|')}|${norm(head)}{${norm(body)}}`,
    })
  }
  return out
}

const norm = (s) => s.replace(/\s+/g, ' ').trim()

function selectorsOf(block) {
  const head = block.slice(0, block.indexOf('{')).trim()
  if (head.startsWith('@')) {
    if (!GROUPING.test(head)) return []
    const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'))
    return blocks(body).flatMap(selectorsOf)
  }
  return head
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const COMBINATOR = /\s*[>+~]\s*|\s+/

function compounds(sel) {
  const out = []
  let buf = ''
  let depth = 0
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

const STATE = /:(hover|active)\b/

function ancestorState(sel) {
  const cs = compounds(sel)
  if (cs.length < 2) return false
  return cs.slice(0, -1).some((c) => STATE.test(c))
}

function targetKey(sel) {
  const cs = compounds(sel)
  return cs[cs.length - 1].replace(/:{1,2}[a-z-]+(\([^)]*\))?/g, '')
}

let affected = 0
for (const [shard, commit] of SHARDS) {
  for (const f of changedCss(commit)) {
    if (!FILES.includes(f)) {
      console.error(`leaf-force-audit: shard ${shard} changed unlisted sheet ${f} — refusing`)
      process.exit(1)
    }
  }
  const deleted = []
  const oldAll = []
  for (const path of FILES) {
    const before = show(`${commit}^`, path)
    if (before == null) continue
    const after = show(commit, path) ?? ''
    const surviving = new Set(flatBlocks(stripComments(after)).map((b) => b.text))
    for (const b of flatBlocks(stripComments(before))) {
      oldAll.push(...b.sels)
      if (!surviving.has(b.text)) deleted.push(...b.sels)
    }
  }

  const ancestorStateTargets = new Map()
  for (const s of oldAll) {
    if (!ancestorState(s)) continue
    const k = targetKey(s)
    if (!ancestorStateTargets.has(k)) ancestorStateTargets.set(k, [])
    ancestorStateTargets.get(k).push(s)
  }

  const q0 = deleted
    .filter((s) => STATE.test(compounds(s).at(-1)) && !ancestorState(s))
    .filter((s) => ancestorStateTargets.has(targetKey(s)))
  const q1 = deleted.filter(ancestorState)

  const flag = q0.length === 0 && q1.length === 0 ? 'CLEAN' : 'HIT'
  if (flag === 'HIT') affected++
  console.log(
    `shard ${shard.padEnd(3)} ${commit}  deleted=${String(deleted.length).padStart(4)}  ` +
      `Q0=${String(q0.length).padStart(3)}  Q1=${String(q1.length).padStart(3)}  ${flag}`,
  )
  for (const s of q0) {
    console.log(`    Q0 ${s}   opposed by: ${[...new Set(ancestorStateTargets.get(targetKey(s)))].join(' | ')}`)
  }
  for (const s of q1) console.log(`    Q1 ${s}`)
}

console.log(`\n${affected}/${SHARDS.length} shards have at least one hit.`)
