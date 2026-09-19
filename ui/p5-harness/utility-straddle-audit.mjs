import { readFileSync } from 'node:fs'
import { leaves, blocks, stripComments, CSS, sources } from './census.mjs'

const only = process.argv[2]

const PREFIX_PROPS = [
  [/^opacity-/, ['opacity']],
  [/^bg-/, ['background-color', 'background', 'background-image']],
  [/^text-\[length:/, ['font-size']],
  [/^text-(?!\[length:)/, ['color', 'font-size']],
  [/^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[)/, ['font-weight']],
  [/^font-(?:sans|serif|mono)/, ['font-family']],
  [/^tracking-/, ['letter-spacing']],
  [/^leading-/, ['line-height']],
  [/^border-b-/, ['border-bottom-color', 'border-bottom-width']],
  [/^border-t-/, ['border-top-color', 'border-top-width']],
  [/^border-l-/, ['border-left-color', 'border-left-width']],
  [/^border-r-/, ['border-right-color', 'border-right-width']],
  [/^border-\d/, ['border-width']],
  [/^border-/, ['border-color', 'border-bottom-color', 'border-top-color', 'border-left-color', 'border-right-color']],
  [/^rounded/, ['border-radius']],
  [/^(?:p|px|py|pt|pb|pl|pr)-/, ['padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right']],
  [/^(?:m|mx|my|mt|mb|ml|mr)-/, ['margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right']],
  [/^(?:w|min-w|max-w)-/, ['width', 'min-width', 'max-width']],
  [/^(?:h|min-h|max-h)-/, ['height', 'min-height', 'max-height']],
  [/^(?:flex|grid|block|inline|hidden|table|contents)$/, ['display']],
  [/^(?:absolute|relative|fixed|sticky|static)$/, ['position']],
  [/^(?:top|bottom|left|right|inset)-/, ['top', 'bottom', 'left', 'right', 'inset']],
  [/^z-/, ['z-index']],
  [/^gap-/, ['gap']],
  [/^cursor-/, ['cursor']],
  [/^shadow/, ['box-shadow']],
  [/^(?:translate|scale|rotate)-/, ['transform']],
  [/^animate-/, ['animation', 'animation-name']],
  [/^overflow-/, ['overflow', 'overflow-x', 'overflow-y']],
  [/^(?:items|justify|self|content)-/, ['align-items', 'justify-content', 'align-self']],
  [/^whitespace-/, ['white-space']],
  [/^uppercase|lowercase|capitalize/, ['text-transform']],
]

function utilityProps(tok) {
  const variants = []
  let rest = tok
  for (;;) {
    const m = /^((?:[\w-]+(?:\/[\w-]+)?)|\[[^\]]*\]):(.*)$/.exec(rest)
    if (!m) break
    variants.push(m[1])
    rest = m[2]
  }
  const bare = rest.replace(/^!/, '').replace(/!$/, '')
  const arb = /^\[([-a-z]+):/.exec(bare)
  if (arb) return { props: [arb[1]], variants, bare }
  for (const [re, props] of PREFIX_PROPS) if (re.test(bare)) return { props, variants, bare }
  return { props: [], variants, bare }
}

const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g
const classesOf = (s) => [...new Set([...s.matchAll(CLASS_RE)].map((m) => m[1]))]

function declaredProps(body) {
  const out = new Set()
  for (const m of body.matchAll(/(^|[;{])\s*(-{0,2}[a-zA-Z][\w-]*)\s*:/g)) {
    if (!m[2].startsWith('--')) out.add(m[2].toLowerCase())
  }
  return out
}

const related = (a, b) => a === b || a.startsWith(b + '-') || b.startsWith(a + '-')

const css = readFileSync(CSS, 'utf8')
const stripped = stripComments(css)
const lines = stripped.split('\n')
const all = leaves(blocks(stripped))
const layered = all.filter((r) => r.ctx.some((c) => c.startsWith('@layer')))

function bodyOf(r) {
  const out = []
  let depth = 0
  for (let i = r.line - 1; i < lines.length; i++) {
    const l = lines[i]
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length
    out.push(l)
    if (depth <= 0 && out.length > 1) break
  }
  return out.join('\n')
}

const strings = []
for (const [path, text] of sources) {
  const t = stripComments(text)
  t.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/(?:className\s*=\s*)?["'`]([^"'`]{4,})["'`]/g)) {
      if (/[a-z]-|\s/.test(m[1])) strings.push({ path, line: i + 1, s: m[1] })
    }
  })
}

const hits = []
for (const r of layered) {
  const classes = classesOf(r.head)
  if (!classes.length) continue
  if (only && !classes.includes(only.replace(/^\./, ''))) continue
  const props = declaredProps(bodyOf(r))
  if (!props.size) continue
  const target = classesOf(r.head.split(',')[0].split(/[\s>+~]+/).filter(Boolean).pop() ?? '')
  const need = target.length ? target : classes
  {
    const t = need[0]
    for (const { path, line, s } of strings) {
      const toks = s.split(/\s+/)
      if (!need.every((c) => toks.includes(c))) continue
      for (const tok of toks) {
        const { props: up, variants, bare } = utilityProps(tok)
        for (const p of up) {
          for (const d of props) {
            if (!related(p.toLowerCase(), d)) continue
            hits.push({
              rule: r.head.replace(/\s+/g, ' ').slice(0, 60),
              ruleLine: r.line,
              prop: d,
              target: t,
              util: (variants.length ? variants.join(':') + ':' : '') + bare,
              where: `${path.split('/').pop()}:${line}`,
              state: (r.head.match(/:[a-z-]+(?:\([^)]*\))?/g) || []).join(''),
              variants: variants.join(','),
            })
          }
        }
      }
    }
  }
}

const seen = new Set()
const uniq = hits.filter((h) => {
  const k = `${h.ruleLine}|${h.prop}|${h.util}|${h.where}`
  return !seen.has(k) && seen.add(k)
})

for (const h of uniq) {
  console.log(
    `styles.css:${String(h.ruleLine).padStart(4)}  ${h.rule}\n` +
      `    LAYERED sets ${h.prop}${h.state ? `  (rule state: ${h.state})` : ''}\n` +
      `    utility  ${h.util}  on .${h.target}  at ${h.where}` +
      `${h.variants ? `  (variants: ${h.variants})` : ''}\n`,
  )
}
console.log(
  `${uniq.length} candidate contest(s) across ${layered.length} layered rules.\n` +
    'Each is a CANDIDATE: same element, same property, layered rule loses. Close each\n' +
    'by checking whether both can apply in the same state — the rule state and the\n' +
    'utility variants are printed so you do not have to reopen the file to see it.',
)
