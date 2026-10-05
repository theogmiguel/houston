// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalPalettePicker } from './TerminalPalettePicker'

afterEach(cleanup)

describe('TerminalPalettePicker', () => {
  it('shows a terminal preview and changes the selected palette tile', () => {
    const onChange = vi.fn()
    render(<TerminalPalettePicker chromeTheme="graphite" value="black" onChange={onChange} />)
    expect(screen.getByTestId('palette-preview').textContent).toContain('cargo test -p houston-core')
    expect(screen.getByTestId('palette-preview').textContent).toContain('1 failed; 3 ignored')
    const tile = screen.getByTestId('palette-tile-marble')
    expect(tile.textContent).toContain('❯ ls -la')
    expect(tile.querySelectorAll('i')).toHaveLength(6)
    expect(tile.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(tile)
    expect(onChange).toHaveBeenCalledWith('marble')
  })
})
