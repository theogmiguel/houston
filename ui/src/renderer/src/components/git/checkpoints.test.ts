import { describe, expect, test } from 'vitest'
import {
  checkpointDeleteConfirm,
  checkpointOwnerLabel,
  checkpointRestoreConfirm,
  checkpointSubtitle,
  defaultCheckpointLabel,
  formatAge
} from './checkpoints'
import type { GitCheckpointInfo } from '../../houston/generated/GitCheckpointInfo'

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)

function cp(over: Partial<GitCheckpointInfo>): GitCheckpointInfo {
  return {
    ref: 'refs/houston/checkpoints/xbWFudWFs/xYmFzZQ',
    label: 'base',
    owner: 'manual',
    sha: '1234567890abcdef',
    created_ms: NOW - 90_000,
    ...over
  }
}

describe('checkpoint labels', () => {
  test('age rounds down into the readable unit', () => {
    expect(formatAge(NOW - 5_000, NOW)).toBe('just now')
    expect(formatAge(NOW - 90_000, NOW)).toBe('1 min ago')
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago')
    expect(formatAge(NOW - 50 * 3_600_000, NOW)).toBe('2 d ago')
    expect(formatAge(null, NOW)).toBe('unknown time')
  })

  test('an owner renders as a person would say it', () => {
    expect(checkpointOwnerLabel('manual')).toBe('manual')
    expect(checkpointOwnerLabel('session_42')).toBe('session 42')
    expect(checkpointOwnerLabel('weird')).toBe('weird')
  })

  test('the subtitle carries owner, age and short sha', () => {
    const s = checkpointSubtitle(cp({ owner: 'session_7' }), NOW)
    expect(s).toContain('session 7')
    expect(s).toContain('1 min ago')
    expect(s).toContain('1234567')
  })

  test('confirms say what is replaced and what survives', () => {
    expect(checkpointRestoreConfirm(cp({}))).toContain('Commits are not moved')
    expect(checkpointRestoreConfirm(cp({}))).toContain('replaces the current files')
    expect(checkpointDeleteConfirm(cp({}))).toContain('files it captured are not touched')
  })

  test('the default label is stable and timestamped in local time', () => {
    // Local components on purpose: the label a person reads is their clock's.
    const label = defaultCheckpointLabel(new Date(2026, 8, 15, 12, 34).getTime())
    expect(label).toBe('manual 2026-09-15 12:34')
  })
})
