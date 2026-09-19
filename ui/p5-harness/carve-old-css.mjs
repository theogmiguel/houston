import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ref = process.argv[2]
if (!ref) {
  console.error('usage: node carve-old-css.mjs <git-ref>   (e.g. p5-33-old-side)')
  process.exit(2)
}
// styles.css no longer exists in the working tree, so this is a path into a
// historical ref only — it must stay as it was, not follow any rename.
const PATH = 'src/renderer/src/styles.css'

// Diffs at the top-level-block granularity, not by line range or text diff:
// the deleted and surviving rule families are interleaved in the source, and
// a block is the smallest unit that can't come out with an unbalanced brace.
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

const oldText = execFileSync('git', ['show', `${ref}:ui/${PATH}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
const newText = readFileSync(PATH, 'utf8')

const surviving = new Set(blocks(newText))
const removed = blocks(oldText).filter((b) => !surviving.has(b))

const text = removed.join('\n') + '\n'
const open = (text.match(/\{/g) || []).length
const close = (text.match(/\}/g) || []).length
if (open !== close) {
  console.error(`carve-old-css: unbalanced output (${open} { vs ${close} }) — refusing to emit`)
  process.exit(1)
}
console.error(`carve-old-css: ${removed.length} blocks removed since ${ref}, ${open} braces balanced`)
process.stdout.write(text)
