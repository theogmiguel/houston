// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrLink } from './PrLink'

describe('PrLink', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens GitHub on Ctrl+click and uses plain click for the panel callback', () => {
    const onClick = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(
      <PrLink href="https://github.com/example/repo/pull/42" onClick={onClick}>
        #42
      </PrLink>,
    )
    const link = screen.getByRole('button', { name: /#42/ })
    fireEvent.click(link, { ctrlKey: true })
    expect(open).toHaveBeenCalledWith('https://github.com/example/repo/pull/42', '_blank', 'noopener,noreferrer')
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.click(link)
    expect(onClick).toHaveBeenCalledOnce()
  })

  describe('inline menu', () => {
    const openMenu = (): void => {
      render(<><PrLink href="https://github.com/example/repo/pull/42">#42</PrLink><p>elsewhere</p></>)
      fireEvent.contextMenu(screen.getByRole('button', { name: /#42/ }))
      expect(screen.queryByRole('menu')).not.toBeNull()
    }

    it('closes on a pointerdown outside it', () => {
      openMenu()
      fireEvent.pointerDown(screen.getByText('elsewhere'))
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('stays open for a pointerdown inside it', () => {
      openMenu()
      fireEvent.pointerDown(screen.getByRole('menuitem', { name: /Copy link/ }))
      expect(screen.queryByRole('menu')).not.toBeNull()
    })

    it('closes on Escape', () => {
      openMenu()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })
})
