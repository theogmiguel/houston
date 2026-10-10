// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MascotSettings } from './MascotSettings'
import { RAIL_POSITION, getMascotPosition, setMascotPosition } from '../../mascot/mascotPosition'
afterEach(() => { cleanup(); setMascotPosition(RAIL_POSITION) })
it('shows the floating position and provides a visible reversal to Rail', () => {
  setMascotPosition({ kind: 'floating', x: .5, y: .5 })
  render(<MascotSettings />)
  expect(screen.getByText('Floating')).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Return to rail' }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  expect(getMascotPosition()).toEqual(RAIL_POSITION)
  expect(screen.getByText('Rail')).toBeTruthy()
  expect(button.disabled).toBe(true)
})
