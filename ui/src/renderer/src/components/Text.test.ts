// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Text, type TextSize, type TextWeight } from './ui/Text'

afterEach(cleanup)

const ROLES: Array<[TextSize, TextWeight]> = [
  ['display', 'display'],
  ['title', 'title'],
  ['heading', 'heading'],
  ['subhead', 'subhead'],
  ['body', 'body'],
  ['ui', 'ui'],
  ['small', 'small'],
  ['label', 'label']
]

describe('Text', () => {
  it('renders each size and weight role with its theme tokens', () => {
    for (const [size, weight] of ROLES) {
      const { container, unmount } = render(createElement(Text, { size, weight }))
      expect(container.firstElementChild?.className).toContain(`var(--tr-text-${size}-size)`)
      expect(container.firstElementChild?.className).toContain(`var(--tr-text-${weight}-weight)`)
      unmount()
    }
  })

  it('keeps display family and label transformation role-specific', () => {
    const display = render(createElement(Text, { size: 'display', weight: 'display' }))
    const label = render(createElement(Text, { size: 'label', weight: 'label' }))
    expect(display.container.firstElementChild?.className).toContain('var(--tr-text-display-family)')
    expect(label.container.firstElementChild?.className).toContain('var(--tr-text-label-transform)')
  })
})
