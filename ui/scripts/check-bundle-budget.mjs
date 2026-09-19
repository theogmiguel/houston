import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The forbidden lists are the durable half: a byte number rots, a named
// package or path that must stay off the boot path does not. Chunks behind a
// dynamic import are deliberately not counted -- moving code there is the fix.

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)))
const STATS_PATH = join(uiDir, 'out/renderer/bundle-stats.json')
const BUDGET_PATH = join(uiDir, 'bundle-budget.json')

export function matchesForbidden(pkg, entry) {
  if (entry.endsWith('*')) return pkg.startsWith(entry.slice(0, -1))
  return pkg === entry
}

export function matchesForbiddenPath(modulePath, entry) {
  if (entry.endsWith('/')) return modulePath.startsWith(entry)
  if (entry.endsWith('*')) return modulePath.startsWith(entry.slice(0, -1))
  return modulePath === entry
}

export function bootClosure(stats) {
  const byName = new Map(stats.chunks.map((c) => [c.fileName, c]))
  const parent = new Map([[stats.entry, null]])
  const order = []
  const queue = [stats.entry]
  while (queue.length > 0) {
    const name = queue.shift()
    const chunk = byName.get(name)
    if (!chunk) {
      throw new Error(
        `bundle-stats.json is inconsistent: chunk "${name}" is imported but not listed — ` +
          `rebuild (bun run build) before running this check`
      )
    }
    order.push(name)
    for (const imp of chunk.imports) {
      if (!parent.has(imp)) {
        parent.set(imp, name)
        queue.push(imp)
      }
    }
  }
  return { order, parent, byName }
}

function chainToEntry(parent, name) {
  const chain = []
  for (let cur = name; cur !== null; cur = parent.get(cur) ?? null) chain.unshift(cur)
  return chain.join(' -> ')
}

export function checkBudget(stats, budget) {
  const violations = []
  const { order, parent, byName } = bootClosure(stats)

  let bootBytes = 0
  for (const name of order) bootBytes += byName.get(name).bytes
  if (bootBytes > budget.maxBootBytes) {
    violations.push(
      `boot payload is ${bootBytes} bytes across ${order.length} chunk(s), over the ` +
        `${budget.maxBootBytes}-byte budget (bundle-budget.json maxBootBytes). Move code ` +
        `behind a dynamic import(), or lower/raise the ratchet with a recorded reason.`
    )
  }

  for (const entry of budget.forbiddenBootPackages) {
    for (const name of order) {
      const hit = byName.get(name).packages.find((p) => matchesForbidden(p, entry))
      if (hit !== undefined) {
        violations.push(
          `forbidden boot package "${hit}" (rule "${entry}") is on the boot path, in chunk ` +
            `${name} (import chain: ${chainToEntry(parent, name)}). It must only be ` +
            `reachable through a dynamic import() — find and break the static chain.`
        )
      }
    }
  }

  for (const entry of budget.forbiddenBootPaths ?? []) {
    for (const name of order) {
      const chunk = byName.get(name)
      if (chunk.appModules === undefined) {
        throw new Error(
          `bundle-stats.json chunk "${name}" has no "appModules" field, but ` +
            `bundle-budget.json declares forbiddenBootPaths (${budget.forbiddenBootPaths.length} ` +
            `rule(s)) — the stats file predates that field; rebuild (bun run build) before ` +
            `running this check`
        )
      }
      const hit = chunk.appModules.find((m) => matchesForbiddenPath(m, entry))
      if (hit !== undefined) {
        violations.push(
          `forbidden boot path "${hit}" (rule "${entry}") is on the boot path, in chunk ` +
            `${name} (import chain: ${chainToEntry(parent, name)}). It must only be ` +
            `reachable through a dynamic import() — find and break the static chain.`
        )
      }
    }
  }
  return violations
}

function main() {
  let stats, budget
  try {
    stats = JSON.parse(readFileSync(STATS_PATH, 'utf8'))
  } catch (err) {
    console.error(
      `check-bundle-budget: cannot read ${STATS_PATH} (${err.message}) — run "bun run build" first`
    )
    process.exit(1)
  }
  budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))

  const violations = checkBudget(stats, budget)
  if (violations.length > 0) {
    for (const v of violations) console.error(`check-bundle-budget: ${v}`)
    process.exit(1)
  }
  const { order, byName } = bootClosure(stats)
  const bootBytes = order.reduce((sum, n) => sum + byName.get(n).bytes, 0)
  console.log(
    `check-bundle-budget: OK — boot payload ${bootBytes} bytes in ${order.length} chunk(s), ` +
      `budget ${budget.maxBootBytes}; ${budget.forbiddenBootPackages.length} forbidden package ` +
      `rule(s) + ${(budget.forbiddenBootPaths ?? []).length} forbidden path rule(s) clean`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
