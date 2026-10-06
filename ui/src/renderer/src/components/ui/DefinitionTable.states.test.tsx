// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefinitionTable, truncateMiddle, type DefinitionRow } from './DefinitionTable'

const ROWS: DefinitionRow[] = [
  { label: 'Ad account', value: 'Ads Growth' },
  { label: 'Account ID', value: '118273645' }
]

describe('DefinitionTable — state matrix', () => {
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
    vi.restoreAllMocks()
  })

  it('Empty — rows not fetched yet renders a neutral placeholder', () => {
    act(() => {
      root.render(<DefinitionTable />)
    })
    expect(container.querySelector('[data-testid="definition-table"]')?.getAttribute('data-state')).toBe('empty')
    expect(container.querySelector('[data-testid="definition-table"]')?.textContent).toBe('–')
  })

  it('Filled — renders every row as icon/label left, value right', () => {
    act(() => {
      root.render(<DefinitionTable rows={ROWS} />)
    })
    const rows = container.querySelectorAll('[data-testid="definition-row"]')
    expect(rows.length).toBe(2)
    expect(container.querySelector('[data-testid="definition-value"]')?.textContent).toBe('Ads Growth')
  })

  it('Hover — N/A: a definition table is a read-only lookup, not a control — no row is pressable, so there is no hover treatment to draw.', () => {
    expect(true).toBe(true)
  })

  it('Focus — N/A: same reason as Hover — nothing in a filled table receives keyboard focus (the retry button, the only focusable element, is covered under Error).', () => {
    expect(true).toBe(true)
  })

  it('Active — N/A: same reason as Hover — no row is pressable.', () => {
    expect(true).toBe(true)
  })

  it('Selected — N/A: rows are facts, not choices among alternatives — nothing in a lookup table is "current".', () => {
    expect(true).toBe(true)
  })

  it('Disabled — carries its reason as visible text and renders inert', () => {
    act(() => {
      root.render(<DefinitionTable rows={ROWS} disabled disabledReason="Workspace not connected" />)
    })
    const el = container.querySelector('[data-testid="definition-table"]')
    expect(el?.getAttribute('data-state')).toBe('disabled')
    expect(el?.textContent).toContain('Workspace not connected')
  })

  it('Loading — shows a loading readout, not stale rows', () => {
    act(() => {
      root.render(<DefinitionTable rows={ROWS} loading />)
    })
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="definition-row"]')).toBeNull()
  })

  it('Error — turns red and offers retry', () => {
    const onRetry = vi.fn()
    act(() => {
      root.render(<DefinitionTable rows={ROWS} error={{ message: 'connection lost', onRetry }} />)
    })
    const el = container.querySelector('[data-testid="definition-table"]')
    expect(el?.className).toContain('border-[var(--danger)]')
    expect(el?.textContent).toContain('connection lost')
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Try again') as HTMLButtonElement
    act(() => retry.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('Overflow — a long machine string truncates in the middle, keeping both ends, with the full value in a title', () => {
    const long = 'mcp__acme_plugins__apollo_apollo_emailer_messages_create'
    act(() => {
      root.render(<DefinitionTable rows={[{ label: 'Tool', value: long, truncateMiddleAt: 30 }]} />)
    })
    const valueEl = container.querySelector('[data-testid="definition-value"]') as HTMLElement
    expect(valueEl.textContent).toContain('…')
    expect(valueEl.textContent).toContain(long.slice(0, 5))
    expect(valueEl.textContent).toContain(long.slice(-5))
    expect(valueEl.textContent?.length).toBeLessThan(long.length)
    expect(valueEl.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(long)
  })

  it('Empty set — a fetched, known-zero row list shows a distinct message, not an empty table', () => {
    act(() => {
      root.render(<DefinitionTable rows={[]} emptySetLabel="No integrations connected" />)
    })
    const el = container.querySelector('[data-testid="definition-table"]')
    expect(el?.getAttribute('data-state')).toBe('empty-set')
    expect(el?.textContent).toBe('No integrations connected')
  })

  it('mask — redacts the value, never renders the full secret anywhere in the DOM (not text, not title, not data-*)', () => {
    const secret = 'sk-svcacct-THIS_PART_MUST_NEVER_APPEAR_IN_THE_DOM'
    act(() => {
      root.render(<DefinitionTable rows={[{ label: 'API key', value: secret, mask: true }]} />)
    })
    const row = container.querySelector('[data-testid="definition-row"]') as HTMLElement
    expect(row.outerHTML).not.toContain('THIS_PART_MUST_NEVER_APPEAR_IN_THE_DOM')
    expect(row.outerHTML).not.toContain(secret)
    const valueEl = container.querySelector('[data-testid="definition-value"]') as HTMLElement
    expect(valueEl.textContent).toContain('****')
    expect(valueEl.getAttribute('title')).toBeNull()
  })

  describe('maskValue, through a masked row', () => {
    const cases: Array<[string, string, string]> = [
      ['a delimited key keeps its scheme marker', 'sk-svcacct-9Qh2LmZ0pXvT', 'sk-svcacct-****'],
      ['an opaque token reveals nothing', 'a9Qh2LmZ0pXvT4Kd8Rn1Bc', '****'],
      ['a short opaque token reveals nothing', 'abc123', '****'],
      ['a value that is only a marker is fully redacted', 'sk-', '****'],
      ['underscores count as delimiters too', 'ghp_A1B2C3D4E5F6G7', 'ghp_****']
    ]
    for (const [name, input, expected] of cases) {
      it(name, () => {
        act(() => {
          root.render(<DefinitionTable rows={[{ label: 'API key', value: input, mask: true }]} />)
        })
        const valueEl = container.querySelector('[data-testid="definition-value"]') as HTMLElement
        expect(valueEl.textContent).toBe(expected)
        const row = container.querySelector('[data-testid="definition-row"]') as HTMLElement
        expect(row.outerHTML).not.toContain(input.slice(-6))
      })
    }
  })
})

describe('truncateMiddle', () => {
  it('leaves a string shorter than the budget unchanged', () => {
    expect(truncateMiddle('short', 30)).toBe('short')
  })

  it('leaves a string exactly at the budget unchanged', () => {
    expect(truncateMiddle('exactly10c', 10)).toBe('exactly10c')
  })

  it('truncates in the middle, keeping both ends, for a string over budget', () => {
    const result = truncateMiddle('abcdefghijklmnopqrstuvwxyz', 11)
    expect(result.length).toBe(11)
    expect(result).toContain('…')
    expect(result.startsWith('abcde')).toBe(true)
    expect(result.endsWith('wxyz')).toBe(true)
  })

  it('handles a budget of 1 by returning just the ellipsis', () => {
    expect(truncateMiddle('anything longer than one', 1)).toBe('…')
  })
})
