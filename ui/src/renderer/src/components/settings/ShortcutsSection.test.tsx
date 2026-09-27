// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
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
})
