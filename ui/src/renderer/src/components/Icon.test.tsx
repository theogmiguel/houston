// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Icon, ICON_ROLE_CLS } from './Icon'
import { IconFile, IconPlus } from './icons'
import type { TextRole } from './Text'

const ROLES: TextRole[] = [
  'display',
  'title',
  'heading',
  'subhead',
  'body',
  'ui',
  'small',
  'label'
]

describe('Icon — metrics derive in CSS, from the neighbouring rung', () => {
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

  it('sizes the box in em off the rung font-size and reads stroke from the token', () => {
    for (const role of ROLES) {
      const cls = ICON_ROLE_CLS[role]
      expect(cls, role).toContain(`[font-size:var(--tr-icon-${role}-size)]`)
      expect(cls, role).toContain('[width:1em]')
      expect(cls, role).toContain('[height:1em]')
      expect(cls, role).toContain(`[stroke-width:var(--tr-icon-${role}-stroke)]`)
      expect(cls, role).not.toMatch(/\d+px/)
    }
  })

  it('renders the glyph itself, so no wrapper box sits between icon and rhythm', () => {
    act(() => root.render(<Icon glyph={IconPlus} role="small" />))
    const svg = container.firstElementChild as SVGElement
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg.getAttribute('class')).toBe(ICON_ROLE_CLS.small)
  })

  it('swaps in the tight-cut drawing for the label/small/ui band, unchanged at the call site', () => {
    act(() => root.render(<Icon glyph={IconFile} role="ui" />))
    expect(container.querySelector('svg')!.querySelectorAll('path')).toHaveLength(1)
  })

  it('keeps the standard drawing above the tight band', () => {
    act(() => root.render(<Icon glyph={IconFile} role="body" />))
    expect(container.querySelector('svg')!.querySelectorAll('path')).toHaveLength(2)
  })

  it('falls back to the standard drawing when a glyph has no tight cut', () => {
    act(() => root.render(<Icon glyph={IconPlus} role="label" />))
    expect(container.querySelector('svg')!.querySelectorAll('path')).toHaveLength(2)
  })

  it('stays hidden from assistive tech unless it is given a name', () => {
    act(() => root.render(<Icon glyph={IconPlus} />))
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    act(() => root.render(<Icon glyph={IconPlus} label="Add pane" />))
    const named = container.querySelector('svg')!
    expect(named.getAttribute('role')).toBe('img')
    expect(named.getAttribute('aria-label')).toBe('Add pane')
    expect(named.getAttribute('aria-hidden')).toBeNull()
  })
})
