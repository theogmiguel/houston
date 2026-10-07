// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { TagPopoverHost, parseTagColor, useTagPopover, preloadTagPopoverSurface } from './TagPopover'
import { TagCardAffordance } from './TagCardAffordance'

beforeAll(() => preloadTagPopoverSurface())

const tags: TagInfo[] = [
  { id: 1, name: 'ui', color: '#a78bfa' },
  { id: 2, name: 'backend', color: '#22d3ee' },
]
const grids = [{ id: 'grid-1', title: 'Grid one', tags: [1] }]
afterEach(cleanup)
function Fixture({ actions = {} }: { actions?: Record<string, ReturnType<typeof vi.fn>> }): React.JSX.Element {
  const base = {
    onCreate: vi.fn((name: string, color: string) => ({ id: 3, name, color })),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onRestore: vi.fn(),
    onApply: vi.fn(),
    onFilter: vi.fn(),
  }
  const merged = { ...base, ...actions }
  return (
    <TagPopoverHost tags={tags} grids={grids} actions={merged}>
      <OpenButton />
    </TagPopoverHost>
  )
}
function OpenButton(): React.JSX.Element {
  const { open } = useTagPopover()
  return (
    <button type="button" onClick={(event) => open({ anchor: event.currentTarget, gridId: 'grid-1' })}>
      Open tags
    </button>
  )
}
function HandoffFixture(): React.JSX.Element {
  const [visible, setVisible] = useState(true)
  return (
    <TagPopoverHost tags={tags} grids={grids} actions={{
      onCreate: (name, color) => ({ id: 3, name, color }),
      onUpdate: vi.fn(), onDelete: vi.fn(), onApply: vi.fn(),
    }}>
      {visible && <HandoffButton onHandoff={() => setVisible(false)} />}
    </TagPopoverHost>
  )
}
function HandoffButton({ onHandoff }: { onHandoff: () => void }): React.JSX.Element {
  const { open } = useTagPopover()
  return (
    <button type="button" onClick={(event) => {
      open({ anchor: event.currentTarget, gridId: 'grid-1' })
      onHandoff()
    }}>Open tags</button>
  )
}

describe('TagPopover', () => {
  it('shows the pick view and applies a tag to the selected grid', () => {
    const onApply = vi.fn()
    render(<Fixture actions={{ onApply }} />)
    fireEvent.click(screen.getByText('Open tags'))
    expect(screen.getByRole('dialog', { name: 'Tags' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /backend/ }))
    expect(onApply).toHaveBeenCalledWith('grid-1', [1, 2])
  })

  it('keeps the popover anchored to the originating row when that row is handed off', async () => {
    render(<HandoffFixture />)
    const trigger = screen.getByText('Open tags')
    trigger.getBoundingClientRect = () => ({
      x: 100, y: 50, left: 100, top: 50, right: 140, bottom: 70, width: 40, height: 20,
      toJSON: () => ({}),
    } as DOMRect)
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByTestId('tag-popover').style.left).toBe('144px'))
    expect(screen.getByTestId('tag-popover').style.top).toBe('46px')
  })

  it('creates a tag inline and applies it to the grid that opened the popover', () => {
    const onCreate = vi.fn((name: string, color: string) => ({ id: 3, name, color }))
    const onApply = vi.fn()
    render(<Fixture actions={{ onCreate, onApply }} />)
    fireEvent.click(screen.getByText('Open tags'))
    fireEvent.click(screen.getByText('New tag…'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Tag name' }), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Color #a78bfa' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith('fresh', '#a78bfa')
    expect(onApply).toHaveBeenCalledWith('grid-1', [1, 3])
    expect(screen.getByRole('menuitemcheckbox', { name: /fresh/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('opens manage, edits a row inline, and confirms deletion with undo', () => {
    const onDelete = vi.fn(),
      onRestore = vi.fn()
    render(<Fixture actions={{ onDelete, onRestore }} />)
    fireEvent.click(screen.getByText('Open tags'))
    fireEvent.click(screen.getByText('Manage tags…'))
    expect(screen.getByText('2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit ui' }))
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Tags' }), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete ui' }))
    expect(screen.getByTestId('tag-delete-confirm').textContent).toContain('Remove ui from 1 grid?')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onRestore).toHaveBeenCalledWith(tags[0], ['grid-1'])
  })

  it('returns to the previous view on Escape before closing and restores trigger focus', async () => {
    render(<Fixture />)
    const trigger = screen.getByText('Open tags')
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('New tag…'))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Tags' }), { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('tag-popover').querySelector('[data-view]')?.getAttribute('data-view')).toBe('pick'))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Tags' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('tag-popover')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})

describe('tag colors and card affordance', () => {
  it('normalizes short hex, six digit hex and rgb colors, and rejects malformed values', () => {
    expect(parseTagColor('#abc')).toBe('#aabbcc')
    expect(parseTagColor('#12aBef')).toBe('#12abef')
    expect(parseTagColor('rgb(12, 34, 56)')).toBe('#0c2238')
    expect(parseTagColor('rgb(256, 0, 0)')).toBeNull()
    expect(parseTagColor('not-a-color')).toBeNull()
  })

  it('uses the first tag color and reports the remaining count', () => {
    render(<TagCardAffordance tags={tags} onClick={vi.fn()} />)
    const button = screen.getByTestId('tag-card-affordance')
    expect(button.textContent).toContain('+1')
    expect(button.querySelector('svg')).toBeTruthy()
  })
})
