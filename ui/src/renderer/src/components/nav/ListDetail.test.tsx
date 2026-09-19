// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ListDetail, type ListDetailItem } from './ListDetail'

function items(ids: string[]): ListDetailItem[] {
  return ids.map((id) => ({ id, title: id, sub: `sub-${id}` }))
}

describe('ListDetail — the shared list+detail shell', () => {
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

  function render(list: ListDetailItem[]): void {
    act(() => {
      root.render(
        <ListDetail
          items={list}
          backLabel="Back"
          renderDetail={(item) => <div data-testid="detail-body">{item ? item.title : 'nothing selected'}</div>}
        />
      )
    })
  }

  function listCol(): HTMLElement {
    return container.querySelector('[data-testid="list-detail-list"]')!
  }
  function detailCol(): HTMLElement {
    return container.querySelector('[data-testid="list-detail-detail"]')!
  }
  function itemButtons(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('[data-testid="list-detail-item"]'))
  }

  it('the two-column shape is an @container override over a stacked default', () => {
    render(items(['a', 'b']))
    const shell = container.querySelector('[data-testid="list-detail"]')!
    expect(shell.className).toContain('grid-cols-1')
    expect(shell.className).toContain('[@container_(min-width:720px)]:grid-cols-[280px_minmax(0,1fr)]')
  })

  it('nothing selected: the list shows unconditionally, the detail is stacked-hidden with no NavBack', () => {
    render(items(['a', 'b']))
    expect(listCol().className).not.toContain('hidden')
    expect(detailCol().className).toContain('hidden')
    expect(detailCol().className).toContain('[@container_(min-width:720px)]:flex')
    expect(container.querySelector('[data-testid="nav-back"]')).toBeNull()
    expect(container.querySelector('[data-testid="detail-body"]')?.textContent).toBe('nothing selected')
  })

  it('picking an item stacked-hides the list, shows the detail with a NavBack that itself hides at the wide rung', () => {
    render(items(['a', 'b']))
    act(() => itemButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(listCol().className).toContain('hidden')
    expect(listCol().className).toContain('[@container_(min-width:720px)]:flex')
    expect(detailCol().className).not.toContain('hidden')
    const back = container.querySelector('[data-testid="nav-back"]')!
    expect(back).not.toBeNull()
    expect(back.parentElement?.parentElement?.className).toContain(
      '[@container_(min-width:720px)]:hidden'
    )
    expect(container.querySelector('[data-testid="detail-body"]')?.textContent).toBe('a')
  })

  it('clicking NavBack clears the selection', () => {
    render(items(['a', 'b']))
    act(() => itemButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const back = container.querySelector('[data-testid="nav-back"]')!
    act(() => back.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.querySelector('[data-testid="detail-body"]')?.textContent).toBe('nothing selected')
  })

  it('falls back to the first remaining item when the selected one disappears', () => {
    const list = items(['a', 'b', 'c'])
    render(list)
    act(() => itemButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.querySelector('[data-testid="detail-body"]')?.textContent).toBe('b')

    render(items(['a', 'c']))
    expect(container.querySelector('[data-testid="detail-body"]')?.textContent).toBe('a')
  })

  it('forceDetailOpen shows the detail with nothing selected, and NavBack defers to onCloseForced', () => {
    let closed = 0
    act(() => {
      root.render(
        <ListDetail
          items={items(['a', 'b'])}
          backLabel="Back"
          forceDetailOpen
          onCloseForced={() => (closed += 1)}
          renderDetail={(item) => <div data-testid="detail-body">{item ? item.title : 'draft'}</div>}
        />
      )
    })
    expect(listCol().className).toContain('hidden')
    expect(detailCol().className).not.toContain('hidden')
    expect(container.querySelector('[data-testid="detail-body"]')?.textContent).toBe('draft')
    const back = container.querySelector('[data-testid="nav-back"]')!
    act(() => back.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(closed).toBe(1)
  })

  it('marks the selected item, and only it, current', () => {
    render(items(['a', 'b']))
    act(() => itemButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(itemButtons()[0].getAttribute('aria-current')).toBeNull()
    expect(itemButtons()[1].getAttribute('aria-current')).toBe('true')
  })
})
