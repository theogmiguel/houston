// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPrViewedMarksForTests,
  markPrFileUnviewed,
  markPrFileViewed,
  patchHash,
  prViewedKey,
  prViewedMarks,
  viewedFingerprint,
  viewedState
} from './prViewedMarks'
import { parsePrDiff } from './prDetailUi'

const KEY = prViewedKey('github.com', 'acme/houston', 412)

beforeEach(() => {
  localStorage.clear()
  clearPrViewedMarksForTests()
})

describe('patchHash', () => {
  it('is stable for the same text and 16 hex digits long', () => {
    expect(patchHash('@@ -1 +1 @@\n-old\n+new')).toMatch(/^[0-9a-f]{16}$/)
    expect(patchHash('@@ -1 +1 @@\n-old\n+new')).toBe(patchHash('@@ -1 +1 @@\n-old\n+new'))
  })

  it('differs when any line of the patch changes', () => {
    const before = patchHash('@@ -1 +1 @@\n-old\n+new')
    expect(patchHash('@@ -1 +1 @@\n-old\n+newer')).not.toBe(before)
    expect(patchHash('')).not.toBe(patchHash('\n'))
  })
})

describe('viewedState', () => {
  it('reads an absent mark as unviewed', () => {
    expect(viewedState(undefined, 'a1b2')).toBe('unviewed')
  })

  it('reads a matching mark as viewed', () => {
    expect(viewedState('a1b2c3d4e5f60718', 'a1b2c3d4e5f60718')).toBe('viewed')
  })

  it('reads a stale mark as changed, never viewed', () => {
    expect(viewedState('a1b2c3d4e5f60718', 'ffffffffffffffff')).toBe('changed')
  })

  it('reads a file the patch cut off as unknown, marked or not', () => {
    expect(viewedState('a1b2c3d4e5f60718', null)).toBe('unknown')
    expect(viewedState(undefined, null)).toBe('unknown')
  })
})

describe('viewedFingerprint', () => {
  const REBASED = `diff --git a/core/orchestrate.rs b/core/orchestrate.rs
index 1a2b3c4..5d6e7f8 100644
--- a/core/orchestrate.rs
+++ b/core/orchestrate.rs
@@ -108,2 +208,3 @@
-    wake_parent(parent);
+    for parent in parents {
+        wake_parent(parent);
+    }
`
  const ORIGINAL = `diff --git a/core/orchestrate.rs b/core/orchestrate.rs
index 9a8b7c6..0d1e2f3 100644
--- a/core/orchestrate.rs
+++ b/core/orchestrate.rs
@@ -10,2 +10,3 @@
-    wake_parent(parent);
+    for parent in parents {
+        wake_parent(parent);
+    }
`

  it('ignores hunk headers and index lines, so identical edits on a newer base keep their mark', () => {
    expect(patchHash(viewedFingerprint(parsePrDiff(REBASED)[0]))).toBe(patchHash(viewedFingerprint(parsePrDiff(ORIGINAL)[0])))
  })

  it('changes when an added line changes', () => {
    const edited = ORIGINAL.replace('+        wake_parent(parent);', '+        wake_parents(parents);')
    expect(patchHash(viewedFingerprint(parsePrDiff(edited)[0]))).not.toBe(patchHash(viewedFingerprint(parsePrDiff(ORIGINAL)[0])))
  })

  it('changes when a line moves between the added and removed sides', () => {
    const swapped = ORIGINAL.replace('-    wake_parent(parent);', '+    wake_parent(parent);')
    expect(patchHash(viewedFingerprint(parsePrDiff(swapped)[0]))).not.toBe(patchHash(viewedFingerprint(parsePrDiff(ORIGINAL)[0])))
  })

  it('carries the rename identity, so a renamed file reads changed', () => {
    const renamed = ORIGINAL.replace('diff --git a/core/orchestrate.rs b/core/orchestrate.rs\nindex 9a8b7c6..0d1e2f3 100644\n--- a/core/orchestrate.rs', 'diff --git a/core/old.rs b/core/orchestrate.rs\nindex 9a8b7c6..0d1e2f3 100644\n--- a/core/old.rs')
    expect(patchHash(viewedFingerprint(parsePrDiff(renamed)[0]))).not.toBe(patchHash(viewedFingerprint(parsePrDiff(ORIGINAL)[0])))
  })

  const fingerprintOf = (patch: string): string => patchHash(viewedFingerprint(parsePrDiff(patch)[0]))
  const BINARY = `diff --git a/assets/logo.png b/assets/logo.png
index 3f2a1b0..7c4d9e2 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`

  it('changes when a binary file gets new content', () => {
    expect(fingerprintOf(BINARY.replace('..7c4d9e2', '..a91b0c3'))).not.toBe(fingerprintOf(BINARY))
  })

  it('keeps a binary file whose base alone moved', () => {
    expect(fingerprintOf(BINARY.replace('3f2a1b0..', '0e0e0e0..'))).toBe(fingerprintOf(BINARY))
  })

  it('changes when only the file mode changes', () => {
    const modeOnly = 'diff --git a/scripts/run.sh b/scripts/run.sh\nold mode 100644\nnew mode 100755\n'
    expect(fingerprintOf(modeOnly.replace('new mode 100755', 'new mode 100644'))).not.toBe(fingerprintOf(modeOnly))
  })

  it('carries rename and similarity lines that describe the change itself', () => {
    const renameOnly = 'diff --git a/core/old.rs b/core/new.rs\nsimilarity index 100%\nrename from core/old.rs\nrename to core/new.rs\n'
    expect(fingerprintOf(renameOnly.replace('rename to core/new.rs', 'rename to core/newer.rs'))).not.toBe(fingerprintOf(renameOnly))
    expect(fingerprintOf(renameOnly.replace('similarity index 100%', 'similarity index 92%'))).not.toBe(fingerprintOf(renameOnly))
  })
})

describe('prViewedKey', () => {
  it('names the host, repository and number, so forks never share marks', () => {
    expect(prViewedKey('github.com', 'acme/houston', 412)).toBe('github.com/acme/houston#412')
    expect(prViewedKey('github.com', 'fork/houston', 412)).not.toBe(KEY)
  })
})

describe('marks', () => {
  it('records and withdraws per-file hashes', () => {
    markPrFileViewed(KEY, 'core/orchestrate.rs', patchHash('old'))
    expect(prViewedMarks(KEY)).toEqual({ 'core/orchestrate.rs': patchHash('old') })
    markPrFileViewed(KEY, 'docs/user/tasks.md', patchHash('docs'))
    markPrFileUnviewed(KEY, 'core/orchestrate.rs')
    expect(prViewedMarks(KEY)).toEqual({ 'docs/user/tasks.md': patchHash('docs') })
    markPrFileUnviewed(KEY, 'docs/user/tasks.md')
    expect(prViewedMarks(KEY)).toEqual({})
  })

  it('ignores a null key, so an unidentified PR still renders', () => {
    expect(() => markPrFileViewed(null, 'a', 'b')).not.toThrow()
    expect(prViewedMarks(null)).toEqual({})
  })

  it('keeps marks across a module reload, through storage', async () => {
    markPrFileViewed(KEY, 'core/orchestrate.rs', patchHash('old'))
    vi.resetModules()
    const fresh = await import('./prViewedMarks')
    expect(fresh.prViewedMarks(KEY)).toEqual({ 'core/orchestrate.rs': patchHash('old') })
  })

  it('evicts the oldest pull request past the cap', () => {
    for (let number = 0; number < 200; number += 1) markPrFileViewed(prViewedKey('github.com', 'acme/houston', number), 'a', patchHash(String(number)))
    expect(prViewedMarks(prViewedKey('github.com', 'acme/houston', 0))).toEqual({ a: patchHash('0') })
    markPrFileViewed(prViewedKey('github.com', 'acme/houston', 200), 'a', patchHash('200'))
    expect(prViewedMarks(prViewedKey('github.com', 'acme/houston', 0))).toEqual({})
    expect(prViewedMarks(prViewedKey('github.com', 'acme/houston', 1))).toEqual({ a: patchHash('1') })
    expect(prViewedMarks(prViewedKey('github.com', 'acme/houston', 200))).toEqual({ a: patchHash('200') })
  })

  it('survives storage that refuses both reads and writes, for the session', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    vi.resetModules()
    try {
      const fresh = await import('./prViewedMarks')
      expect(() => fresh.markPrFileViewed(KEY, 'core/orchestrate.rs', patchHash('old'))).not.toThrow()
      expect(fresh.prViewedMarks(KEY)).toEqual({ 'core/orchestrate.rs': patchHash('old') })
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('reads nothing out of corrupt storage', async () => {
    localStorage.setItem('tr-pr-viewed-marks', '{not json')
    vi.resetModules()
    const fresh = await import('./prViewedMarks')
    expect(fresh.prViewedMarks(KEY)).toEqual({})
  })

  it('drops entries whose shapes storage cannot vouch for', async () => {
    localStorage.setItem('tr-pr-viewed-marks', JSON.stringify({ 'github.com/acme/houston#7': { at: 'tuesday', files: {} }, 'github.com/acme/houston#8': { at: 5, files: { a: 3 } }, 'github.com/acme/houston#9': { at: 5, files: { a: 'h1' } } }))
    vi.resetModules()
    const fresh = await import('./prViewedMarks')
    expect(fresh.prViewedMarks(prViewedKey('github.com', 'acme/houston', 7))).toEqual({})
    expect(fresh.prViewedMarks(prViewedKey('github.com', 'acme/houston', 8))).toEqual({})
    expect(fresh.prViewedMarks(prViewedKey('github.com', 'acme/houston', 9))).toEqual({ a: 'h1' })
  })
})
