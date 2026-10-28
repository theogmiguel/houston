// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { LaunchSlotCardSpecimen } from './LaunchSlotCard'

afterEach(cleanup)
it('uses the native select tier and matching input-tier fields inside a concentric launch card', () => {
  render(<LaunchSlotCardSpecimen custom />)
  for (const select of screen.getAllByRole('combobox')) {
    expect(select.className).toContain('rounded-[var(--tr-radius-button)]')
    expect(select.className).toContain('bg-[var(--field)]')
    expect(select.className).toContain('text-[length:var(--tr-text-ui-size)]')
    expect(select.className).toContain('h-[var(--h-pill)]')
  }
  for (const field of [screen.getByText('This checkout · Houston'), screen.getByRole('textbox', { name: 'Typed model ID for slot 1' })]) {
    expect(field.className).toContain('rounded-[var(--tr-radius-input)]')
    expect(field.className).toContain('bg-[var(--content-bg)]')
    expect(field.className).toContain('text-[length:var(--tr-text-ui-size)]')
    expect(field.className).toContain('h-[var(--h-ctl)]')
  }
  const card = screen.getByText('builder').closest('[data-slot]')!
  expect(card.className).toContain('rounded-[var(--tr-radius-card)]')
  expect(card.className).toContain('p-[var(--space-2)]')
})
