// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstRunFolderOffers, type FirstRunFolderOffersProps } from './FirstRunFolderOffers'
import type { AgentFolder } from '../../houston/generated/AgentFolder'

const DAY = 24 * 60 * 60 * 1_000

function folder(path: string, daysAgo: number, sessions = 2): AgentFolder {
  return { path, last_active_ms: Date.now() - daysAgo * DAY, sessions }
}

function props(over: Partial<FirstRunFolderOffersProps> = {}): FirstRunFolderOffersProps {
  return {
    scanState: 'idle',
    folders: [],
    capped: null,
    error: null,
    adding: false,
    onScan: () => {},
    onAdd: () => {},
    ...over
  }
}

describe('FirstRunFolderOffers', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const render = (p: FirstRunFolderOffersProps): void => {
    act(() => root.render(<FirstRunFolderOffers {...p} />))
  }
  const click = (testid: string): void => {
    act(() => host.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click())
  }
  const rows = (): HTMLElement[] => Array.from(host.querySelectorAll('[data-testid="first-run-folder-row"]'))
  const checkedPaths = (): string[] =>
    rows()
      .filter((row) => row.querySelector<HTMLButtonElement>('[role="checkbox"]')!.getAttribute('aria-checked') === 'true')
      .map((row) => row.dataset.path!)

  it('asks before reading anything, then reports it is looking', () => {
    const onScan = vi.fn()
    render(props({ onScan }))
    expect(host.querySelector('[data-testid="first-run-folders-scan"]')).not.toBeNull()
    click('first-run-folders-scan')
    expect(onScan).toHaveBeenCalledOnce()

    render(props({ scanState: 'scanning' }))
    expect(host.querySelector('[data-testid="first-run-folders-status"]')!.textContent).toContain('Looking')
  })

  it('pre-checks recent folders, and adds only the confirmed ones', () => {
    const onAdd = vi.fn()
    const recent = folder('C:\\code\\app', 2)
    const old = folder('C:\\code\\legacy', 60, 5)
    render(props({ scanState: 'done', folders: [recent, old], onAdd }))
    expect(checkedPaths()).toEqual([recent.path])
    const rowsText = host.querySelector('[data-testid="first-run-folders"]')!.textContent!
    expect(rowsText).toContain('app')
    expect(rowsText).toContain('legacy')
    expect(rowsText).toContain('5 sessions')

    // The sixty-day-old folder starts unchecked; adding needs an explicit pick.
    click('first-run-folders-add')
    expect(onAdd).toHaveBeenCalledWith([recent.path])

    act(() => rows()[1].querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
    expect(checkedPaths()).toEqual([recent.path, old.path])
    expect(host.querySelector('[data-testid="first-run-folders-add"]')!.textContent).toContain('2 workspaces')
    click('first-run-folders-add')
    expect(onAdd).toHaveBeenCalledWith([recent.path, old.path])
  })

  it('unchecking every row holds the add button', () => {
    const onAdd = vi.fn()
    const recent = folder('C:\\code\\app', 1)
    render(props({ scanState: 'done', folders: [recent], onAdd }))
    act(() => rows()[0].querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
    const add = host.querySelector<HTMLButtonElement>('[data-testid="first-run-folders-add"]')!
    expect(add.disabled).toBe(true)
    click('first-run-folders-add')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('says when the scan stopped early and offers a rescan', () => {
    const onScan = vi.fn()
    render(
      props({
        scanState: 'done',
        folders: [folder('C:\\code\\app', 1)],
        capped: 'stopped after 10 session transcripts; folders beyond them may be missing',
        onScan
      }),
    )
    expect(host.querySelector('[data-testid="first-run-folders-capped"]')!.textContent).toContain('may be missing')
    click('first-run-folders-rescan')
    expect(onScan).toHaveBeenCalledOnce()
  })

  it('an empty history offers no rows and shows a manual way out', () => {
    render(props({ scanState: 'done', folders: [] }))
    expect(host.querySelector('[data-testid="first-run-folders-empty"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="first-run-folders-add"]')).toBeNull()
  })

  it('a failed scan shows the reason and can be retried', () => {
    const onScan = vi.fn()
    render(props({ scanState: 'error', error: 'the scan failed: boom', onScan }))
    expect(host.querySelector('[data-testid="first-run-folders-error"]')!.textContent).toContain('boom')
    click('first-run-folders-rescan')
    expect(onScan).toHaveBeenCalledOnce()
  })
})
