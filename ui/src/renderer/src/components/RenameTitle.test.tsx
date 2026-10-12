// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RenameTitle } from './RenameTitle'

afterEach(cleanup)

it('identifies automatic names and lets a user override return to automatic', () => {
  const reset = vi.fn()
  const view = render(<RenameTitle title="Review parser" titleSource="cli" onRename={vi.fn()} onReset={reset} />)
  expect(screen.getByText('Auto')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Reset to automatic' })).toBeNull()
  view.rerender(<RenameTitle title="Mine" titleSource="user" onRename={vi.fn()} onReset={reset} />)
  expect(screen.getByText('Manual')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reset to automatic' }))
  expect(reset).toHaveBeenCalledOnce()
})

it('keeps Enter rename and Escape cancellation', () => {
  const rename = vi.fn()
  render(<RenameTitle title="Review parser" titleSource="cli" onRename={rename} />)
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My review' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(rename).toHaveBeenCalledWith('My review')
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(rename).toHaveBeenCalledOnce()
})

it('claims an unchanged automatic name on Enter and leaves an unchanged manual name alone', () => {
  const rename = vi.fn()
  const view = render(<RenameTitle title="Review parser" titleSource="cli" onRename={rename} />)
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(rename).toHaveBeenCalledExactlyOnceWith('Review parser')
  view.rerender(<RenameTitle title="Review parser" titleSource="user" onRename={rename} />)
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(rename).toHaveBeenCalledOnce()
})
