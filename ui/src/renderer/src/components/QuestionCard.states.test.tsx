// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuestionCard, type QuestionCardOption } from './QuestionCard'

const OPTIONS: QuestionCardOption[] = [
  { id: 'a', label: 'Yes, proceed' },
  { id: 'b', label: 'No, cancel' },
  { id: 'c', label: 'Ask me later' }
]

describe('QuestionCard — state matrix', () => {
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

  it('Empty — single-select body with options not yet loaded renders a neutral placeholder', () => {
    act(() => {
      root.render(
        <QuestionCard questionIndex={1} questionCount={1} question="Proceed?" body="single-select" />
      )
    })
    expect(container.querySelector('[data-testid="question-card-empty"]')?.textContent).toBe('–')
  })

  it('Filled — free-text body renders the pager, question and current value', () => {
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={5}
          questionCount={5}
          question="Anything else?"
          body="free-text"
          freeTextValue="Use staging creds"
        />
      )
    })
    expect(container.querySelector('[data-testid="question-card-pager"]')?.textContent).toBe('‹ 5 of 5 ›')
    expect(container.querySelector('[data-testid="question-card-question"]')?.textContent).toBe(
      'Anything else?'
    )
    expect((container.querySelector('[data-testid="question-card-freetext"]') as HTMLTextAreaElement).value).toBe(
      'Use staging creds'
    )
  })

  it('Hover — an option row carries hover treatment', () => {
    act(() => {
      root.render(
        <QuestionCard questionIndex={1} questionCount={1} question="Proceed?" body="single-select" options={OPTIONS} />
      )
    })
    expect(container.querySelector('[data-testid="question-card-option"]')?.className).toContain('hover:bg-')
  })

  it('Focus — an option row carries a visible focus ring', () => {
    act(() => {
      root.render(
        <QuestionCard questionIndex={1} questionCount={1} question="Proceed?" body="single-select" options={OPTIONS} />
      )
    })
    expect(container.querySelector('[data-testid="question-card-option"]')?.className).toContain(
      'focus-visible:shadow-'
    )
  })

  it('Active — an option row carries a press-scale treatment', () => {
    act(() => {
      root.render(
        <QuestionCard questionIndex={1} questionCount={1} question="Proceed?" body="single-select" options={OPTIONS} />
      )
    })
    expect(container.querySelector('[data-testid="question-card-option"]')?.className).toContain('active:scale-')
  })

  it('Selected — single-select marks the chosen row aria-pressed and tinted', () => {
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={1}
          questionCount={1}
          question="Proceed?"
          body="single-select"
          options={OPTIONS}
          selectedId="b"
        />
      )
    })
    const rows = container.querySelectorAll('[data-testid="question-card-option"]')
    expect(rows[1].getAttribute('aria-pressed')).toBe('true')
    expect(rows[1].className).toContain('bg-[var(--accent-muted)]')
    expect(rows[0].getAttribute('aria-pressed')).toBe('false')
  })

  it('Disabled — carries its reason as a title and blocks option clicks', () => {
    const onSelectOption = vi.fn()
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={1}
          questionCount={1}
          question="Proceed?"
          body="single-select"
          options={OPTIONS}
          onSelectOption={onSelectOption}
          disabled
          disabledReason="Session closed"
        />
      )
    })
    const row = container.querySelector('[data-testid="question-card-option"]') as HTMLButtonElement
    expect(row.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Session closed')
    act(() => row.click())
    expect(onSelectOption).not.toHaveBeenCalled()
    const skip = container.querySelector('[data-testid="question-card-skip"]') as HTMLButtonElement
    expect(skip.disabled).toBe(true)
  })

  it('Loading — shows a loading readout and no options', () => {
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={1}
          questionCount={1}
          question="Proceed?"
          body="single-select"
          options={OPTIONS}
          loading
        />
      )
    })
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="question-card-options"]')).toBeNull()
  })

  it('Error — turns red and offers retry', () => {
    const onRetry = vi.fn()
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={1}
          questionCount={1}
          question="Proceed?"
          body="single-select"
          options={OPTIONS}
          error={{ message: 'could not load options', onRetry }}
        />
      )
    })
    expect(container.querySelector('[data-testid="question-card"]')?.className).toContain(
      'border-[var(--danger)]'
    )
    expect(container.textContent).toContain('could not load options')
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Try again') as HTMLButtonElement
    act(() => retry.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('Overflow — a long option list scrolls internally instead of the card growing', () => {
    const manyOptions: QuestionCardOption[] = Array.from({ length: 30 }, (_, i) => ({
      id: `o${i}`,
      label: `Option ${i}`
    }))
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={1}
          questionCount={1}
          question="Pick one"
          body="single-select"
          options={manyOptions}
        />
      )
    })
    const list = container.querySelector('[data-testid="question-card-options"]') as HTMLElement
    expect(list.className).toContain('overflow-y-auto')
  })

  it('Empty set — select body with zero options shows a distinct message, not an empty list', () => {
    act(() => {
      root.render(
        <QuestionCard questionIndex={1} questionCount={1} question="Pick one" body="single-select" options={[]} />
      )
    })
    expect(container.querySelector('[data-testid="question-card-empty-set"]')?.textContent).toBe('No options')
  })

  it('multi-select — checked options render a solid dark fill, not just a checkmark glyph', () => {
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={1}
          questionCount={1}
          question="Pick any"
          body="multi-select"
          options={OPTIONS}
          selectedIds={['a']}
        />
      )
    })
    const boxes = container.querySelectorAll('[data-testid="question-card-checkbox"]')
    expect(boxes[0].getAttribute('data-checked')).toBe('true')
    expect(boxes[0].className).toContain('bg-[var(--accent)]')
    expect(boxes[1].getAttribute('data-checked')).toBe('false')
    expect(boxes[1].className).not.toContain('bg-[var(--accent)]')
  })

  it('escape hatch — is always present in select bodies, numbered one past the last option, and calls onTypeInstead', () => {
    const onTypeInstead = vi.fn()
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={1}
          questionCount={1}
          question="Pick one"
          body="single-select"
          options={OPTIONS}
          onTypeInstead={onTypeInstead}
        />
      )
    })
    const hatch = container.querySelector('[data-testid="question-card-escape-hatch"]') as HTMLButtonElement
    expect(hatch.textContent).toContain('Type it your own')
    expect(hatch.textContent).toContain('4')
    act(() => hatch.click())
    expect(onTypeInstead).toHaveBeenCalledTimes(1)
  })

  it('digit keypress — selects the matching numbered option', () => {
    const onSelectOption = vi.fn()
    act(() => {
      root.render(
        <QuestionCard
          questionIndex={1}
          questionCount={1}
          question="Pick one"
          body="single-select"
          options={OPTIONS}
          onSelectOption={onSelectOption}
        />
      )
    })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }))
    })
    expect(onSelectOption).toHaveBeenCalledWith('b')
  })
})
