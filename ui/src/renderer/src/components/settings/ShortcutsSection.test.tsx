// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShortcutsSection } from './ShortcutsSection'

afterEach(cleanup)

describe('ShortcutsSection', () => {
  it('the pass-through description names the prefix key as the chord it keeps', () => {
    render(
      <ShortcutsSection
        keymapOverrides={{ bindings: {}, shortcuts_enabled: true }}
        onKeymapOverrides={vi.fn()}
      />
    )
    expect(screen.getByText('Pass through to terminal')).toBeTruthy()
    expect(screen.getByText(/except the prefix key/)).toBeTruthy()
  })

  it('filters shortcut rows by search text', () => {
    render(<ShortcutsSection keymapOverrides={{ bindings: {}, shortcuts_enabled: true }} onKeymapOverrides={vi.fn()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search shortcuts' }), { target: { value: 'workspace' } })
    expect(screen.getByText('close the current workspace')).toBeTruthy()
    expect(screen.queryByText('open the "Add pane" menu')).toBeNull()
  })

  it('shows conflicts while recording and Replace assigns the captured chord', () => {
    const onKeymapOverrides = vi.fn()
    render(<ShortcutsSection keymapOverrides={{ bindings: {}, shortcuts_enabled: true }} onKeymapOverrides={onKeymapOverrides} />)
    fireEvent.click(screen.getByRole('button', { name: 'F2' }))
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true, shiftKey: true })
    expect(screen.getByText(/Conflicts with close the current workspace/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(onKeymapOverrides).toHaveBeenLastCalledWith(expect.objectContaining({
      bindings: expect.objectContaining({
        'rename-workspace': { code: 'KeyW', ctrl: true, shift: true, alt: false, meta: false },
        'close-workspace': { code: 'F2', ctrl: false, shift: false, alt: false, meta: false }
      })
    }))
  })
})
