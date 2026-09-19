// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackdropMount } from './BackdropMount'
import { setBackgroundStateForTests } from '../backgroundMode'

const importSpy = vi.hoisted(() => vi.fn())

vi.mock('./CustomBackdrop', () => {
  importSpy()
  return { CustomBackdrop: () => <div data-testid="custom-backdrop" /> }
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('BackdropMount', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    importSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setBackgroundStateForTests({ mode: 'solid' })
  })

  function render(): void {
    act(() => {
      root.render(<BackdropMount theme="graphite" />)
    })
  }

  it('renders nothing and loads nothing in Solid', () => {
    setBackgroundStateForTests({ mode: 'solid' })
    render()
    expect(container.innerHTML).toBe('')
    expect(importSpy).not.toHaveBeenCalled()
  })

  it('reaches for the field in Custom', async () => {
    setBackgroundStateForTests({ mode: 'custom' })
    render()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(importSpy).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="custom-backdrop"]')).not.toBeNull()
  })
})
