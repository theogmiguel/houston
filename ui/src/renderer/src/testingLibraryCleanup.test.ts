// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

// Vitest runs without globals, so Testing Library never registers its own cleanup. A tree
// left mounted keeps its timers, which fire after the environment is torn down and fail
// the run with an unhandled error.
const RENDERER_SRC = path.resolve(__dirname)
const RENDER_IMPORT = /import\s*\{[^}]*\brender\b[^}]*\}\s*from\s*'@testing-library\/react'/

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return testFiles(full)
    return /\.test\.tsx?$/.test(entry.name) ? [full] : []
  })
}

it('every test file that renders with Testing Library unmounts with cleanup', () => {
  const missing = testFiles(RENDERER_SRC)
    .filter((file) => {
      const src = readFileSync(file, 'utf8')
      return RENDER_IMPORT.test(src) && !/afterEach\(\s*cleanup\s*\)|\bcleanup\(\)/.test(src)
    })
    .map((file) => path.relative(RENDERER_SRC, file))
  expect(missing, 'expected each file to call afterEach(cleanup)').toEqual([])
})
