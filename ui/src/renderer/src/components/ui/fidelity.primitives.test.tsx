// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionMenu, UsageModelCell, UsageProviderRow, UsageSectionHeading, UsageShareBar } from './index'

afterEach(cleanup)

describe('fidelity primitives', () => {
  it('opens an accessible action menu and invokes the selected row action', () => {
    const onEdit = vi.fn()
    render(<ActionMenu label="Routine actions" iconOnly items={[{ label: 'Edit', onSelect: onEdit }, { label: 'Delete', onSelect: vi.fn(), tone: 'danger' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Routine actions' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('renders a provider summary and accessible share bar', () => {
    const { container } = render(<UsageProviderRow mark={<span>✳</span>} label="Claude Code" sessions={3} amount="$12.00" note="20K tokens" share={0.75} color="var(--claude)" />)
    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(container.textContent).toContain('3 sessions · 20K tokens')
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('75')
  })

  it('uses the UI section heading and names models above their colored share bars', () => {
    const { container } = render(<><UsageSectionHeading>Breakdown</UsageSectionHeading><UsageModelCell mark={<span>◎</span>} name="gpt-5.5-codex" share={0.4} color="var(--text-primary)" /></>)
    expect(screen.getByRole('heading', { name: 'Breakdown' }).className).toContain('tr-text-ui-size')
    expect(screen.getByText('gpt-5.5-codex').className).not.toContain('font-mono')
    expect(container.querySelector('span[aria-hidden="true"] span')?.getAttribute('style')).toContain('linear-gradient')
  })

  it('formats share amounts with grouped currency and square swatches', () => {
    const { container } = render(<UsageShareBar heading="Cost by type" segments={[{ id: 'cache-read', label: 'Cache read', value: 1021.7 }]} />)
    expect(container.textContent).toContain('$1,021.70')
    expect(container.querySelector('[data-testid="usage-share-cost-by-type"] span[aria-hidden="true"]')?.className).not.toContain('rounded-full')
  })
})
