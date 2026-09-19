// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = path.resolve(__dirname)
const SOURCE_FILE = path.join(RENDERER_SRC, 'usePreferences.ts')

function exportedNames(): string[] {
  const src = readFileSync(SOURCE_FILE, 'utf8')
  const names: string[] = []
  for (const m of src.matchAll(/^export (?:const|type) (\w+)/gm)) {
    if (m[1] !== 'usePreferences' && !m[1].endsWith('_KEY')) names.push(m[1])
  }
  return names
}

function consumersOutsideSettings(name: string): string[] {
  let out = ''
  try {
    out = execFileSync(
      'git',
      ['grep', '-n', '-w', '--', name, '--', 'ui/src/renderer/src'],
      { cwd: path.resolve(RENDERER_SRC, '../../../..'), encoding: 'utf8' }
    )
  } catch (e) {
    const err = e as { status?: number }
    if (err.status === 1) return []
    throw e
  }
  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => !l.startsWith('ui/src/renderer/src/usePreferences.ts:'))
    .filter((l) => !l.startsWith('ui/src/renderer/src/components/settings/'))
}

describe('usePreferences — every exported preference key has a consumer outside Settings', () => {
  const names = exportedNames()

  it('the export list itself is non-empty — a passing empty suite proves nothing', () => {
    expect(names.length).toBeGreaterThan(0)
  })

  for (const name of names) {
    it(`${name} is read somewhere other than usePreferences.ts and components/settings/`, () => {
      expect(
        consumersOutsideSettings(name),
        `${name} has no consumer outside components/settings/ — it may be a dead row`
      ).not.toHaveLength(0)
    })
  }
})
