// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { STATUS_ICON_WORD, StatusIcon, type StatusIconState } from './StatusIcon'

const STATES: StatusIconState[] = ['ok', 'differs', 'off', 'absent']

describe('StatusIcon', () => {
  it('draws a mark for every state', () => {
    for (const state of STATES) {
      const { container, unmount } = render(<StatusIcon state={state} />)
      const svg = container.querySelector('svg')
      expect(svg, state).toBeTruthy()
      expect(svg?.children.length, `${state} drew nothing`).toBeGreaterThan(0)
      unmount()
    }
  })

  it('renders no word when label is omitted', () => {
    const { container } = render(<StatusIcon state="ok" />)
    expect(container.querySelector('[data-testid="status-icon"]')?.textContent).toBe('')
  })

  it('renders the word beside the icon when label is passed', () => {
    for (const state of STATES) {
      const { container, unmount } = render(<StatusIcon state={state} label={STATUS_ICON_WORD[state]} />)
      expect(container.textContent).toBe(STATUS_ICON_WORD[state])
      unmount()
    }
  })

  it('colours differ per state — status never rests on shape alone', () => {
    const colors = new Set(
      STATES.map((state) => {
        const { container, unmount } = render(<StatusIcon state={state} />)
        const style = container.querySelector<HTMLElement>('[data-testid="status-icon"]')!.style.color
        unmount()
        return style
      })
    )
    expect(colors.size).toBe(STATES.length)
  })
})
