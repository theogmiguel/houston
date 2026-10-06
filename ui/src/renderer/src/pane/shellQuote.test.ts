import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { shellQuote } from './shellQuote'

describe('shellQuote', () => {
  it('round-trips a path with a space, single quote, double quote and $ through sh -c', () => {
    const path = `/tmp/a b'c"d$e`
    const out = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(path)}`], {
      encoding: 'utf8'
    })
    expect(out).toBe(path)
  // Spawning sh on the Windows runner (Git Bash) usually takes under 1 s but has
  // exceeded vitest's 5 s default while the rest of the suite loads the machine.
  }, 30_000)

  it('wraps a plain path in single quotes', () => {
    expect(shellQuote('/tmp/foo')).toBe("'/tmp/foo'")
  })
})
