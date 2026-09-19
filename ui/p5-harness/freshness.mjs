import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const OLD_SIDE_REF = 'p5-33-old-side'
const OLD_SIDE_PATH = 'ui/src/renderer/src/styles.css'

// `old-full.css` is a frozen COPY of the deleted stylesheet, pinned to the last
// commit that had it. A stale copy does not error — it prints confident numbers
// against the wrong baseline. It is imported with ?raw, so regenerate THEN rebuild.
export function assertOldSideFresh() {
  const copyPath = join(HERE, 'old-full.css')
  let copy
  try {
    copy = readFileSync(copyPath, 'utf8')
  } catch (e) {
    fail(`cannot read ${copyPath} — ${e.message}`)
  }
  let head
  try {
    head = execFileSync('git', ['show', `${OLD_SIDE_REF}:${OLD_SIDE_PATH}`], {
      cwd: join(HERE, '..', '..'),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
  } catch (e) {
    fail(
      `cannot read ${OLD_SIDE_REF}:${OLD_SIDE_PATH} — ${e.message}\n` +
        `${OLD_SIDE_REF} is a tag on the last commit that still had styles.css. If this\n` +
        `is a fresh clone, fetch tags: git fetch --tags`
    )
  }
  if (copy === head) return

  const c = copy.split('\n')
  const h = head.split('\n')
  let firstDiff = 0
  while (firstDiff < c.length && firstDiff < h.length && c[firstDiff] === h[firstDiff]) firstDiff++
  fail(
    `old-full.css does not match ${OLD_SIDE_REF}:${OLD_SIDE_PATH}.\n` +
      `  copy: ${c.length} lines · pinned: ${h.length} lines · first difference at line ${firstDiff + 1}\n` +
      `  copy line ${firstDiff + 1}: ${JSON.stringify(c[firstDiff] ?? '<eof>')}\n` +
      `  HEAD line ${firstDiff + 1}: ${JSON.stringify(h[firstDiff] ?? '<eof>')}\n` +
      `\n` +
      `The old side is comparing against a stylesheet that is not HEAD, so every\n` +
      `number this run would print is against the wrong baseline. Regenerate it:\n` +
      `  git show ${OLD_SIDE_REF}:${OLD_SIDE_PATH} > ui/p5-harness/old-full.css\n` +
      `then REBUILD the harness (it is imported with ?raw at build time, so a\n` +
      `regenerated file that was not rebuilt is still stale in the browser):\n` +
      `  bunx vite build --config p5-harness/vite.config.mts\n` +
      `\n` +
      `Retiring landed shards' Old*.tsx fixtures is the SAME invariant — the\n` +
      `sheet and the mounted fixtures must describe one commit. This check can\n` +
      `only see the sheet half; the fixture half is still on you.`
  )
}

function fail(msg) {
  console.error(`\nold-side freshness gate FAILED\n${msg}\n`)
  process.exit(2)
}
