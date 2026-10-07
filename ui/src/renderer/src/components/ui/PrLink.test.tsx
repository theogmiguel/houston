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
})
