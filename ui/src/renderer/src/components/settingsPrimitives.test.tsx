// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Row, Toggle } from './settingsPrimitives'

describe('Row — type ladder (toggle-04)', () => {
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

  it('renders the label on --tr-text-ui-size, not a hand-typed 12px literal', () => {
    act(() => {
      root.render(<Row title="Some setting" desc="Its description" />)
    })
    const row = container.querySelector('[data-testid="settings-row"]')!
    const label = row.querySelectorAll('div')[1]
    expect(label.className).toContain('text-[length:var(--tr-text-ui-size)]')
    expect(label.className).not.toContain('text-[12px]')
  })

  it('renders the description on --tr-text-small-size, not a hand-typed 11px literal', () => {
    act(() => {
      root.render(<Row title="Some setting" desc="Its description" />)
    })
    const row = container.querySelector('[data-testid="settings-row"]')!
    const desc = row.querySelectorAll('div')[2]
    expect(desc.className).toContain('text-[length:var(--tr-text-small-size)]')
    expect(desc.className).toContain('var(--tr-text-small-leading)')
    expect(desc.className).not.toContain('text-[11px]')
  })

  it('Toggle keeps its .sw hook untouched by the type-ladder change', () => {
    act(() => {
      root.render(<Toggle on={false} onChange={() => {}} />)
    })
    expect(container.querySelector('.sw')).not.toBeNull()
  })
})
