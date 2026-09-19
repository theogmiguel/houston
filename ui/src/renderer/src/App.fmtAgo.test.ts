// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fmtAgo } from './App'

const NOW = 1_700_000_000_000
const ago = (s: number): number => NOW - s * 1000

describe('fmtAgo buckets (E-toast-3)', () => {
  it('reads "just now" only for the first ten seconds', () => {
    expect(fmtAgo(ago(0), NOW)).toBe('just now')
    expect(fmtAgo(ago(9), NOW)).toBe('just now')
  })

  it('counts seconds for the rest of the first minute', () => {
    expect(fmtAgo(ago(10), NOW)).toBe('10s ago')
    expect(fmtAgo(ago(42), NOW)).toBe('42s ago')
    expect(fmtAgo(ago(59), NOW)).toBe('59s ago')
  })

  it('keeps every boundary above it exactly where it was', () => {
    expect(fmtAgo(ago(60), NOW)).toBe('1m ago')
    expect(fmtAgo(ago(3599), NOW)).toBe('59m ago')
    expect(fmtAgo(ago(3600), NOW)).toBe('1h ago')
    expect(fmtAgo(ago(86_399), NOW)).toBe('23h ago')
    expect(fmtAgo(ago(86_400), NOW)).toBe('1d ago')
  })

  it('clamps a future timestamp to "just now" rather than counting backwards', () => {
    expect(fmtAgo(NOW + 5_000, NOW)).toBe('just now')
  })
})
