// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { HarnessReport } from '../../houston/useHarness'
import { loadMarkdownPipeline } from '../MarkdownPreview'
import { HarnessHistory } from './HarnessHistory'
import { HarnessReportView } from './HarnessReportView'
// Warm the lazy dependency graph before timed layout assertions.
await loadMarkdownPipeline()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REVIEW: HarnessReview = {
  id: 3,
  workspace: '/home/dev/proj',
  routine_id: 7,
  run_id: 11,
  status: 'published',
  started_at_ms: Date.UTC(2026, 8, 15),
  run_dir: '/home/dev/proj/.houston/harness/r11',
  window: ['2026-09-01', '2026-09-15'],
  finding_count: 1
}

describe('Harness report and history layout', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders the report markdown in flow inside its card', async () => {
    const report: HarnessReport = {
      reviewId: REVIEW.id,
      markdown: '# Review report\n\nFindings are listed below.',
      truncated: false
    }
    await act(async () => {
      root.render(
        <HarnessReportView
          reviews={[REVIEW]}
          report={report}
          reportError={null}
          onLoadReport={vi.fn()}
          onOpenFile={vi.fn()}
          onReveal={vi.fn()}
        />
      )
      await loadMarkdownPipeline()
    })

    const card = container.querySelector('[data-testid="harness-report"]')
    const preview = card?.querySelector('[data-testid="chat-preview-markdown"]')
    expect(preview).not.toBeNull()
    expect(preview?.querySelector('h1')?.textContent).toBe('Review report')
    expect(container.querySelector('[data-testid="editor-preview-markdown"]')).toBeNull()
  })

  it('keeps Started and Window on one line and permits horizontal table overflow', () => {
    act(() =>
      root.render(<HarnessHistory reviews={[REVIEW]} liveSessions={new Set()} onOpenSession={vi.fn()} />)
    )

    const headers = Array.from(container.querySelectorAll('th'))
    const startedIndex = headers.findIndex((header) => header.textContent === 'Started')
    const windowIndex = headers.findIndex((header) => header.textContent === 'Window')
    const cells = Array.from(container.querySelectorAll('tbody tr[data-testid="data-table-row"] td'))
    const table = container.querySelector('[data-testid="data-table"]')

    expect(cells[startedIndex].querySelector('span')?.className).toContain('whitespace-nowrap')
    expect(cells[windowIndex].querySelector('span')?.className).toContain('whitespace-nowrap')
    expect(headers[startedIndex].getAttribute('style')).toContain('160px')
    expect(headers[windowIndex].getAttribute('style')).toContain('260px')
    expect((table as HTMLElement | null)?.style.minWidth).toBe('1000px')
    expect(table?.parentElement?.className).toContain('overflow-x-auto')
  })

  it('shows a correlated report error with a retry action', () => {
    const onLoadReport = vi.fn()
    act(() =>
      root.render(
        <HarnessReportView
          reviews={[REVIEW]}
          report={null}
          reportError={{
            workspace: REVIEW.workspace,
            reviewId: REVIEW.id,
            message: 'report.md is missing'
          }}
          onLoadReport={onLoadReport}
          onOpenFile={vi.fn()}
          onReveal={vi.fn()}
        />
      )
    )

    expect(container.textContent).toContain('report.md is missing')
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!.click())
    expect(onLoadReport).toHaveBeenCalledWith(REVIEW.id)
  })
})
