// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ComposerPillMenu, ComposerPillOption } from './ComposerPill'

afterEach(cleanup)
it('insets composer menu rows on every side with concentric row corners', () => {
  render(<ComposerPillMenu variant="options" role="listbox"><ComposerPillOption selected>Opus</ComposerPillOption><ComposerPillOption selected={false}>Sonnet</ComposerPillOption></ComposerPillMenu>)
  expect(screen.getByRole('listbox').className).toContain('p-[var(--space-1)]')
  for (const row of screen.getAllByRole('option')) {
    expect(row.className).toContain('rounded-[var(--tr-radius-sm)]')
    expect(row.className).toContain('px-[var(--space-2)]')
  }
})
