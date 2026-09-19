// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SurfaceBoundary } from './SurfaceBoundary'

function Boom(): React.JSX.Element {
  throw new Error('boom')
}

describe('SurfaceBoundary', () => {
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

  it('renders children when nothing throws', () => {
    act(() => {
      root.render(
        <SurfaceBoundary label="Test surface">
          <div>ok</div>
        </SurfaceBoundary>
      )
    })
    expect(container.textContent).toBe('ok')
  })

  it('catches a render throw and shows a labeled fallback with a retry button', () => {
    act(() => {
      root.render(
        <SurfaceBoundary label="Test surface">
          <Boom />
        </SurfaceBoundary>
      )
    })
    expect(container.textContent).toContain('Test surface crashed: boom')
    expect(container.querySelector('button')).not.toBeNull()
  })

  it('retry clears the error and re-renders the children', () => {
    let shouldThrow = true
    function Flaky(): React.JSX.Element {
      if (shouldThrow) throw new Error('boom')
      return <div>recovered</div>
    }
    act(() => {
      root.render(
        <SurfaceBoundary label="Flaky surface">
          <Flaky />
        </SurfaceBoundary>
      )
    })
    expect(container.textContent).toContain('crashed')
    shouldThrow = false
    act(() => {
      container.querySelector('button')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })
    expect(container.textContent).toBe('recovered')
  })
})
