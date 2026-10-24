// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NightShiftReport } from './NightShiftReport'
import { NIGHT_NOW, nightEntry, nightRun } from '../../test/nightShiftFixtures'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('NightShiftReport', () => {
  it('headlines a refused run with its reason', () => {
    const run = nightRun({ phase: 'refused', ended_at_ms: NIGHT_NOW, stop_detail: 'missed: the machine was not running Houston before wrap-up (12 min late)' })
    act(() => root.render(<NightShiftReport run={run} report={null} workers={['zcode', 'claude']} holdForQa={false} onDecide={() => {}} onQaPassed={() => {}} onLoadReport={() => {}} />))
    const head = host.querySelector('[data-testid="night-headline"]')?.textContent
    expect(head).toBe('Night shift did not start: missed: the machine was not running Houston before wrap-up (12 min late)')
  })

  it('renders the morning report', () => {
    const onDecide = vi.fn()
    const onQaPassed = vi.fn()
    const run = nightRun({
      phase: 'settled', ended_at_ms: NIGHT_NOW, stop_reason: 'report', report_published: true, summary: 'Two PRs and a decision',
      merge_order: [13, 12], limited: ['claude'],
      entries: [
        nightEntry({ id: 1, kind: 'pr', title: 'Tray fix', theme: 'reliability', pr_number: 12,
          gates: { checks: 'passed', review: 'passed', qa: 'none', ci: 'failed', reruns: 1 } }),
        nightEntry({ id: 2, kind: 'pr', title: 'Faster diff', theme: 'performance', pr_number: 13, visible: true,
          gates: { checks: 'passed', review: 'pending', qa: 'passed', ci: 'passed', reruns: 0 } }),
        nightEntry({ id: 3, kind: 'decision', title: 'Drop the old API?', body: 'It has no callers.\n\nOptions: keep | remove' }),
        nightEntry({ id: 4, kind: 'decision', title: 'Rename the tray?', choice: 'Go ahead' }),
        nightEntry({ id: 5, kind: 'flaky', title: 'pty::resize_race' })
      ]
    })
    act(() => root.render(<NightShiftReport run={run} report={null} workers={['zcode', 'claude']} holdForQa onDecide={onDecide} onQaPassed={onQaPassed} onLoadReport={() => {}} />))
    expect(host.querySelector('[data-testid="night-headline"]')?.textContent).toBe('2 PRs, 1 open decision')
    expect(host.textContent).toContain('Report published')

    const decisions = host.querySelector('section[aria-label="Decisions"]')!
    expect(decisions.textContent).toContain('It has no callers.')
    expect(decisions.textContent).toContain('Answered: Go ahead')
    act(() => Array.from(decisions.querySelectorAll('button')).find((b) => b.textContent === 'remove')!.click())
    expect(onDecide).toHaveBeenCalledWith(3, 'remove')

    expect(host.querySelector('[role="group"][aria-label="Theme reliability"]')?.textContent).toContain('#12 Tray fix')
    expect(host.querySelector('[role="group"][aria-label="Theme performance"]')?.textContent).toContain('#13 Faster diff')
    const chips = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="gate-chip"]'))
    const chip = (label: string, pr: string): HTMLElement => {
      const group = host.querySelector(`[role="group"][aria-label="Theme ${pr}"]`)!
      return Array.from(group.querySelectorAll<HTMLElement>('[data-testid="gate-chip"]')).find((c) => c.textContent?.startsWith(label))!
    }
    expect(chips.length).toBe(7)
    expect(chip('Checks', 'reliability').dataset.gateKind).toBe('fact')
    expect(chip('CI', 'reliability').dataset.gateState).toBe('failed')
    expect(chip('Review', 'performance').dataset.gateKind).toBe('verdict')
    expect(chip('QA', 'performance').dataset.gateKind).toBe('verdict')
    expect(host.textContent).toContain('CI re-run 1× for a known flaky test')

    act(() => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Mark QA passed')!.click())
    expect(onQaPassed).toHaveBeenCalledWith(2)

    const order = host.querySelector('section[aria-label="Merge order"]')!.textContent
    expect(order!.indexOf('#13')).toBeLessThan(order!.indexOf('#12'))
    const events = host.querySelector('section[aria-label="Events"]')!.textContent
    expect(events).toContain('Interrupted at')
    expect(events).toContain('Claude Code limited')
    expect(events).toContain('Later Claude Code spawns used ZCode.')
    expect(events).toContain('Known flaky test')
    const cost = host.querySelector('section[aria-label="Cost"]')?.textContent
    expect(cost).toContain('7.5')
    expect(cost).toContain('1 pane')
    expect(cost).not.toContain('1 panes')
  })

  it('counts open decisions in the headline while an answered one stays listed', () => {
    const run = nightRun({
      phase: 'settled', ended_at_ms: NIGHT_NOW, stop_reason: 'report',
      entries: [
        nightEntry({ id: 1, kind: 'pr', title: 'Tray fix', pr_number: 12 }),
        nightEntry({ id: 2, kind: 'decision', title: 'Drop the old API?', body: 'Options: keep | remove', choice: 'keep' })
      ]
    })
    act(() => root.render(<NightShiftReport run={run} report={null} workers={['zcode']} holdForQa={false} onDecide={() => {}} onQaPassed={() => {}} onLoadReport={() => {}} />))
    expect(host.querySelector('[data-testid="night-headline"]')?.textContent).toBe('1 PR, no open decisions')
    expect(host.querySelector('section[aria-label="Decisions"]')?.textContent).toContain('Answered: keep')
  })
})
