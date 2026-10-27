// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SuspectedDefect } from '../../houston/generated/SuspectedDefect'
import { HarnessDefects, type HarnessDefectsProps } from './HarnessDefects'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = '/home/dev/proj'

function defect(overrides: Partial<SuspectedDefect> = {}): SuspectedDefect {
  return {
    workspace: WS,
    key: 'repeated-refusal',
    title: 'A pane_reply was refused twice for one question',
    source: 'detector',
    detector: 'reply_refused',
    evidence: ['message 91 refused', 'message 92 refused'],
    destination: 'houston',
    count: 2,
    first_seen_ms: Date.UTC(2026, 8, 14),
    last_seen_ms: Date.UTC(2026, 8, 15),
    state: 'open',
    recurred: false,
    issue_url: null,
    decided_at_ms: null,
    ...overrides
  }
}

describe('HarnessDefects', () => {
  let container: HTMLDivElement
  let root: Root
  let props: HarnessDefectsProps

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    props = { defects: [defect()], onDecide: vi.fn(), onOpenIssue: vi.fn() }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  function render(over: Partial<HarnessDefectsProps> = {}): void {
    act(() => root.render(<HarnessDefects {...props} {...over} />))
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === label)
    if (!found) throw new Error(`no button "${label}"`)
    return found
  }

  it('lists title, source, destination, count, last seen and the recurred marker', () => {
    render({ defects: [defect({ recurred: true })] })
    expect(container.textContent).toContain('Suspected defects')
    expect(container.textContent).toContain('A pane_reply was refused twice for one question')
    expect(container.textContent).toContain('Detector: reply_refused')
    expect(container.textContent).toContain('Houston')
    expect(container.textContent).toContain('2 times')
    expect(container.textContent).toContain('recurred')
    expect(container.querySelector('section[aria-label="Suspected defects"]')).not.toBeNull()
  })

  it('opens an issue and records dismiss and not-a-bug decisions', () => {
    render()
    act(() => button('Open issue').click())
    expect(props.onOpenIssue).toHaveBeenCalledWith('repeated-refusal')

    act(() => button('Dismiss').click())
    expect(props.onDecide).toHaveBeenCalledWith('repeated-refusal', 'dismiss')

    const toggle = container.querySelector<HTMLButtonElement>('[role="listitem"] button[aria-expanded]')!
    act(() => toggle.click())
    act(() => button('Not a bug').click())
    expect(props.onDecide).toHaveBeenCalledWith('repeated-refusal', 'not_a_bug')
  })

  it('shows a filed defect through its issue link and offers reopen on a decided one', () => {
    render({
      defects: [defect({ state: 'resolved', issue_url: 'https://github.com/acme/houston/issues/42', count: 3 })]
    })
    const link = Array.from(container.querySelectorAll('a')).find((node) => node.textContent === 'View issue')
    expect(link?.getAttribute('href')).toBe('https://github.com/acme/houston/issues/42')
    act(() => button('Reopen').click())
    expect(props.onDecide).toHaveBeenCalledWith('repeated-refusal', 'reopen')
  })

  it('shows a dismissed defect as decided and offers reopen', () => {
    render({ defects: [defect({ state: 'dismissed', decided_at_ms: 1 })] })
    expect(container.textContent).toContain('Dismissed')
    act(() => button('Reopen').click())
    expect(props.onDecide).toHaveBeenCalledWith('repeated-refusal', 'reopen')
  })

  it('says so when a workspace has no suspected defects', () => {
    render({ defects: [] })
    expect(container.textContent).toContain('No suspected defects.')
  })
})
