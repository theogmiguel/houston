import { describe, expect, it } from 'vitest'
import { formatCheckout } from './formatCheckout'

describe('formatCheckout', () => {
  it('formats the primary checkout and branch', () => {
    expect(formatCheckout({ root: '/repo', kind: 'primary', branch: 'fix/x', head: 'abcdef012345' })).toEqual({
      kind: 'primary',
      badge: 'primary',
      branch: 'fix/x',
      text: 'primary · fix/x',
    })
  })

  it('formats a worktree with its slug and branch', () => {
    expect(
      formatCheckout({ root: '/repo-wt', kind: { worktree: { slug: 'feature' } }, branch: 'feat/x', head: 'abcdef0' }),
    ).toEqual({
      kind: 'worktree',
      badge: 'wt/feature',
      branch: 'feat/x',
      text: 'wt/feature · feat/x',
    })
  })

  it('formats folder, remote, detached and unknown identities', () => {
    expect(formatCheckout({ root: '/folder', kind: 'folder', branch: null, head: null })).toMatchObject({
      kind: 'folder',
      badge: 'folder',
      text: 'folder',
    })
    expect(formatCheckout(null, { remoteHost: 'buildbox' })).toMatchObject({
      kind: 'remote',
      badge: 'remote buildbox',
      text: 'remote · buildbox',
    })
    expect(formatCheckout({ root: '/repo', kind: 'primary', branch: null, head: 'abcdef012345' })).toMatchObject({
      kind: 'detached',
      badge: 'detached abcdef0',
      branch: null,
    })
    expect(formatCheckout(undefined)).toEqual({ kind: 'unknown', badge: 'unknown', branch: null, text: 'unknown' })
  })
})
