import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// THE BASELINE IS A RATCHET, NOT AN EXEMPTION: up fails as a regression, down
// fails asking for the pin to be lowered, and a file absent from it must have
// nothing over the ceiling. It records the debt, not a blessed list.

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)))
const BASELINE_PATH = join(uiDir, 'complexity-baseline.json')
const OXLINT = join(uiDir, 'node_modules/.bin/oxlint')
const SCAN_ROOT = process.env.SCAN_ROOT
const SRC = SCAN_ROOT === undefined ? join(uiDir, 'src') : resolve(SCAN_ROOT)
const BASE = SCAN_ROOT === undefined ? uiDir : dirname(uiDir)

export function componentFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(path)
    }
  }
  walk(root)
  return out.map((p) => relative(BASE, p))
}

const MESSAGE_SHAPE = /complexity of (\d+)\. Maximum allowed is (\d+)\./
const COMPLEXITY_CODE = 'eslint(complexity)'

export function perFile(diagnostics, ceiling) {
  const out = {}
  for (const d of diagnostics) {
    const found = MESSAGE_SHAPE.exec(d.message ?? '')
    if (found === null) {
      throw new Error(
        `check-complexity: oxlint diagnostic has no complexity number: ${JSON.stringify(d.message)} ` +
          `— expected a message shaped "…has a complexity of <N>. Maximum allowed is <M>."`
      )
    }
    const score = Number(found[1])
    const file = d.filename
    const prev = out[file] ?? { total: 0, worst: 0, over: 0 }
    out[file] = {
      total: prev.total + score,
      worst: Math.max(prev.worst, score),
      over: prev.over + (score > ceiling ? 1 : 0)
    }
  }
  return out
}

const FIELDS = ['worst', 'over']
const shape = (v) => `worst ${v.worst}/over ${v.over} (total ${v.total})`

export function checkComplexity(actual, pinned, present, max) {
  const violations = []

  for (const [file, have] of Object.entries(actual).sort()) {
    const pin = pinned[file]
    if (pin === undefined) {
      if (have.over === 0) continue
      violations.push(
        `${file} — ${shape(have)} against the ${max}-path ceiling; this file is not in the ` +
          `baseline, so its allowance is 0. Move a gated JSX block into a real top-level ` +
          `component taking props, or collapse repeated inline ternaries into one pure helper. ` +
          `Wrapping the JSX in a closure moves the points to that closure and lowers nothing — ` +
          `which is why "total" is pinned. The baseline only shrinks.`
      )
      continue
    }
    const risen = FIELDS.filter((f) => have[f] > pin[f])
    if (risen.length > 0) {
      violations.push(
        `${file} — ${risen.map((f) => `${f} ${pin[f]} → ${have[f]}`).join(', ')} ` +
          `(total ${pin.total} → ${have.total}). A ratchet only falls. If the number fell because ` +
          `a block of JSX was wrapped in a zero-arg closure, that is not a fix — the total will ` +
          `show it barely moved.`
      )
    }
  }

  for (const [file, pin] of Object.entries(pinned).sort()) {
    const have = actual[file]
    if (have === undefined) {
      const why = present.has(file) ? `now clean — delete the entry` : `no longer exists — delete the entry`
      violations.push(`${file} — pinned at ${shape(pin)} but ${why}.`)
      continue
    }
    if (FIELDS.some((f) => have[f] < pin[f])) {
      violations.push(
        `${file} — now ${shape(have)}, pin says ${shape(pin)}: lower the pin to keep the ` +
          `ratchet honest.`
      )
    }
  }
  return violations
}

function runOxlint(files) {
  if (!existsSync(OXLINT)) {
    throw new Error(
      `check-complexity: ${OXLINT} is missing — run "bun install" (oxlint is a pinned devDependency)`
    )
  }
  const rcPath = join(mkdtempSync(join(tmpdir(), 'houston-cx-')), 'oxlintrc.json')
  writeFileSync(rcPath, JSON.stringify({ rules: { complexity: ['error', { max: 1 }] } }))
  const proc = spawnSync(
    OXLINT,
    ['-c', rcPath, '--disable-nested-config', '-f', 'json', ...files],
    { cwd: BASE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  if (proc.error !== undefined) throw proc.error
  let parsed
  try {
    parsed = JSON.parse(proc.stdout)
  } catch (err) {
    throw new Error(
      `check-complexity: oxlint did not emit parseable JSON (${err.message}); ` +
        `stderr was: ${proc.stderr.trim() || '(empty)'}`
    )
  }
  if (parsed.number_of_files !== files.length) {
    throw new Error(
      `check-complexity: oxlint linted ${parsed.number_of_files} file(s) but ${files.length} ` +
        `were passed — a scanned path was skipped, so a clean result would be a lie`
    )
  }
  const all = parsed.diagnostics ?? []
  return all.filter((d) => d.code === COMPLEXITY_CODE)
}

function main() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const files = componentFiles(SRC)
  const diagnostics = runOxlint(files)

  const actual = perFile(diagnostics, baseline.max)

  if (process.argv.includes('--baseline')) {
    const block = Object.fromEntries(
      Object.entries(actual)
        .sort()
        .filter(([, v]) => v.over > 0)
        .map(([f, v]) => [f, { total: v.total, worst: v.worst, over: v.over }])
    )
    console.log(JSON.stringify({ files: block }, null, 2))
    return
  }

  const violations = checkComplexity(actual, baseline.files, new Set(files), baseline.max)
  if (violations.length > 0) {
    console.error(
      `check-complexity: FAIL — cyclomatic complexity above the pinned baseline ` +
        `(ceiling ${baseline.max} decision paths per function):`
    )
    for (const v of violations) console.error(`  ${v}`)
    console.error(
      `  "node scripts/check-complexity.mjs --baseline" prints the new files block for ` +
        `complexity-baseline.json.`
    )
    process.exit(1)
  }
  const pinned = Object.keys(baseline.files).length
  const debt = Object.values(baseline.files).reduce((n, v) => n + v.total, 0)
  const worst = Object.values(baseline.files).reduce((m, v) => Math.max(m, v.worst), 0)
  console.log(
    `check-complexity: OK — ${files.length} component file(s) scanned, ${pinned} pinned ` +
      `(total ${debt}, worst ${worst}), ceiling ${baseline.max}`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
