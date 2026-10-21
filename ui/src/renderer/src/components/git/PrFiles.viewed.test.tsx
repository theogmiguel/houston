// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PullRequestLink } from '../../houston/client'
import type { PrDiffView } from './usePrDetailSubscription'
import { parsePrDiff } from './prDetailUi'
import { clearPrViewedMarksForTests, markPrFileViewed, patchHash, prViewedKey, viewedFingerprint } from './prViewedMarks'
import { PrFiles } from './PrFiles'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  localStorage.clear()
  clearPrViewedMarksForTests()
})

const LINK = {
  host: 'github.com',
  repository: 'acme/houston',
  number: 412,
  url: 'https://github.com/acme/houston/pull/412',
  state: 'open',
  is_draft: false,
  title: 'Batch wake requests per parent'
} as PullRequestLink

const NOOP = (): void => {}

const PATCH = `diff --git a/core/orchestrate.rs b/core/orchestrate.rs
--- a/core/orchestrate.rs
+++ b/core/orchestrate.rs
@@ -10,2 +10,3 @@
-    wake_parent(parent);
+    for parent in parents {
+        wake_parent(parent);
+    }
diff --git a/docs/user/tasks.md b/docs/user/tasks.md
--- a/docs/user/tasks.md
+++ b/docs/user/tasks.md
@@ -1,2 +1,3 @@
 # Tasks
+Backlogs wake in bounded batches.
`

const FILES = parsePrDiff(PATCH)

function fileHash(path: string): string {
  const file = FILES.find((candidate) => candidate.path === path)
  if (file === undefined) throw new Error(`no fixture file ${path}`)
  return patchHash(viewedFingerprint(file))
}

function renderFiles(patchText: string): ReturnType<typeof render> {
  return render(
    <PrFiles
      link={LINK}
      diff={{ number: 412, patch: patchText, truncated: false, message: null } as PrDiffView}
      loading={false}
      drafts={[]}
      writeBusy={false}
      onAddDraft={NOOP}
      onReload={NOOP}
    />
  )
}

function viewedButton(container: HTMLElement, path: string): HTMLButtonElement {
  const file = container.querySelector(`[data-path="${path}"]`)
  if (file === null) throw new Error(`no file row for ${path}`)
  return within(file as HTMLElement).getByRole('button', { name: 'Viewed' })
}

describe('PrFiles viewed marks', () => {
  it('starts with every file unviewed — no first-file default', () => {
    const { container } = renderFiles(PATCH)
    expect(viewedButton(container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('false')
    expect(viewedButton(container, 'docs/user/tasks.md').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText(/2 files/).textContent).toContain('2 files')
    expect(screen.queryByText('Changed since viewed')).toBeNull()
  })

  it('keeps a viewed mark across an unmount and remount', () => {
    const first = renderFiles(PATCH)
    fireEvent.click(viewedButton(first.container, 'core/orchestrate.rs'))
    expect(viewedButton(first.container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('true')
    first.unmount()
    const second = renderFiles(PATCH)
    expect(viewedButton(second.container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('true')
    expect(viewedButton(second.container, 'docs/user/tasks.md').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText(/1 \/ 2 viewed/).textContent).toContain('1 / 2 viewed')
  })

  it('reads a stored mark with a matching hash as viewed on mount', () => {
    markPrFileViewed(prViewedKey(LINK.host, LINK.repository, LINK.number), 'core/orchestrate.rs', fileHash('core/orchestrate.rs'))
    const { container } = renderFiles(PATCH)
    expect(viewedButton(container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('true')
    expect(viewedButton(container, 'docs/user/tasks.md').getAttribute('aria-pressed')).toBe('false')
  })

  it('shows a file whose stored hash is stale as unviewed with a changed badge, and re-marking clears it', () => {
    const key = prViewedKey(LINK.host, LINK.repository, LINK.number)
    markPrFileViewed(key, 'core/orchestrate.rs', patchHash('the patch as it stood when viewed'))
    const { container } = renderFiles(PATCH)
    expect(viewedButton(container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('Changed since viewed').textContent).toBe('Changed since viewed')
    fireEvent.click(viewedButton(container, 'core/orchestrate.rs'))
    expect(viewedButton(container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('Changed since viewed')).toBeNull()
    expect(localStorage.getItem('tr-pr-viewed-marks')).toContain(fileHash('core/orchestrate.rs'))
  })

  it('keeps a viewed mark when a rebase only moves hunk headers and index blobs', () => {
    const first = renderFiles(PATCH)
    fireEvent.click(viewedButton(first.container, 'core/orchestrate.rs'))
    first.unmount()
    const rebased = PATCH.replace(
      '--- a/core/orchestrate.rs\n+++ b/core/orchestrate.rs\n@@ -10,2 +10,3 @@',
      'index 1a2b3c4..5d6e7f8 100644\n--- a/core/orchestrate.rs\n+++ b/core/orchestrate.rs\n@@ -108,2 +208,3 @@'
    )
    const second = renderFiles(rebased)
    expect(viewedButton(second.container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('Changed since viewed')).toBeNull()
  })

  it('unviewing a persisted mark withdraws it for later sessions', () => {
    const key = prViewedKey(LINK.host, LINK.repository, LINK.number)
    markPrFileViewed(key, 'core/orchestrate.rs', fileHash('core/orchestrate.rs'))
    const first = renderFiles(PATCH)
    expect(viewedButton(first.container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(viewedButton(first.container, 'core/orchestrate.rs'))
    expect(viewedButton(first.container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('false')
    first.unmount()
    const second = renderFiles(PATCH)
    expect(viewedButton(second.container, 'core/orchestrate.rs').getAttribute('aria-pressed')).toBe('false')
  })
})
