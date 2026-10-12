// Fails on any var(--x) in renderer source whose --x is never declared. An undeclared custom
// property without a fallback invalidates its declaration at computed-value time.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const defaultRoot = join(__dirname, '..', 'src', 'renderer', 'src')
const SOURCE_EXT = /\.(css|ts|tsx)$/
const TEST_FILE = /\.test\.(ts|tsx)$/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) out.push(full)
  }
  return out
}

// Declarations: `--x:` in CSS, quoted style-object keys, `['--x' as string]:` inline styles, Tailwind `[--x:v]`, setProperty('--x').
const DECLARATION = /(?:^|[\s{;'"`\[(])(--[A-Za-z0-9_-]+)['"`]?\s*:/g
const TYPED_KEY = /(--[A-Za-z0-9_-]+)['"`]\s+as\s+string\]\s*:/g
const SET_PROPERTY = /setProperty\(\s*['"`](--[A-Za-z0-9_-]+)['"`]/g
// Check fallback references too; interpolated names cannot be resolved statically.
const USE = /var\(\s*(--[A-Za-z0-9_-]+)(?![A-Za-z0-9_$-])\s*[,)]/g

export function findUndeclaredVars(root = defaultRoot) {
  const files = walk(root)
  const declared = new Set()
  const sources = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    sources.set(file, text)
    for (const m of text.matchAll(DECLARATION)) declared.add(m[1])
    for (const m of text.matchAll(SET_PROPERTY)) declared.add(m[1])
    for (const m of text.matchAll(TYPED_KEY)) declared.add(m[1])
  }
  const undeclared = new Map()
  for (const [file, text] of sources) {
    for (const m of text.matchAll(USE)) {
      if (declared.has(m[1])) continue
      const files = undeclared.get(m[1]) ?? new Set()
      files.add(relative(root, file))
      undeclared.set(m[1], files)
    }
  }
  return undeclared
}

export function checkUndeclaredVars(root = defaultRoot) {
  const undeclared = findUndeclaredVars(root)
  if (undeclared.size === 0) return
  const lines = [...undeclared].map(([name, files]) => `  var(${name}) used in ${[...files].sort().join(', ')}`)
  console.error(
    `${undeclared.size} custom propert${undeclared.size === 1 ? 'y is' : 'ies are'} used via var() but never declared:\n${lines.join('\n')}\n` +
      `Declare the property in theme.css or use an existing token (expected: every var(--x) names a --x declared somewhere under ${relative(process.cwd(), root) || root}).`
  )
  process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) checkUndeclaredVars()
