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
  })

  it('wraps a plain path in single quotes', () => {
    expect(shellQuote('/tmp/foo')).toBe("'/tmp/foo'")
  })
})
