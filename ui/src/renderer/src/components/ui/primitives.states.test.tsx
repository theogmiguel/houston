// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, ConnectionCell, Count, STATUS_LABELS, StatusLabel, TextInput } from './index'
import { ThemeRevealSpecimen } from './ThemeRevealSpecimen'
import { OrchestrationNoticeSpecimen } from './OrchestrationNotice'
import { variants } from './variants'

afterEach(cleanup)

const textClass = variants('base', { tone: { quiet: 'muted', loud: 'strong' } }, { tone: 'quiet' })

// @ts-expect-error invalid variant keys are rejected
textClass({ tone: 'unknown' })
// @ts-expect-error Button variants are a closed union
const invalidButtonVariant = <Button variant="tertiary">Save</Button>
// @ts-expect-error icon buttons require an accessible label
const unnamedIconButton = <Button variant="icon" icon={() => <svg />} />
// @ts-expect-error danger-solid buttons require an icon
const unlabeledButton = <Button variant="danger-solid">Delete</Button>
// @ts-expect-error status values come from the fixed vocabulary
const unknownStatus = <StatusLabel status="Offline" />
void unnamedIconButton
void invalidButtonVariant
void unlabeledButton
void unknownStatus

describe('components/ui primitives', () => {
  it('shows the theme reveal with the corrected Paper terminal and all palette contrast rows', () => {
    render(<ThemeRevealSpecimen />)

    expect(screen.getByRole('table', { name: 'Terminal palette contrast ratios' }).querySelectorAll('tbody tr')).toHaveLength(24)
    expect(screen.getByRole('button', { name: 'Switch to Paper' })).toBeTruthy()
    expect(screen.getByTestId('theme-reveal-specimen').getAttribute('data-theme')).toBe('graphite')
  })

  it('specimens both orchestration notice states with working actions', () => {
    render(<OrchestrationNoticeSpecimen />)
    expect(screen.getAllByTestId('orchestration-notice')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Open pane' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Dismiss api-refactor needs your input' })).toBeTruthy()
  })

  it('TextInput keeps its role, width and face, and passes layout and aria through', () => {
    render(<TextInput aria-label="Bot token" type="password" font="mono" width="full" className="flex-1" defaultValue="x" />)
    const input = screen.getByLabelText('Bot token') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.className).toContain('font-mono')
    expect(input.className).toContain('w-full')
    expect(input.className).toContain('flex-1')
    render(<TextInput aria-label="Owner" />)
    const plain = screen.getByLabelText('Owner') as HTMLInputElement
    expect(plain.type).toBe('text')
    expect(plain.className).not.toContain('font-mono')
  })

  it('variants applies defaults and chosen axis classes', () => {
    expect(textClass()).toBe('base muted')
    expect(textClass({ tone: 'loud' })).toBe('base strong')
  })

  it('Button renders each role, size, default type and danger arm', () => {
    const { rerender } = render(<Button variant="primary">Create</Button>)
    const button = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement
    expect(button.type).toBe('button')
    expect(button.className).toContain('bg-[var(--accent)]')
    expect(button.className).toContain('h-[var(--h-ctl)]')

    rerender(<Button variant="secondary" size="sm">Cancel</Button>)
    const secondary = screen.getByRole('button', { name: 'Cancel' })
    expect(secondary.className).toContain('h-[var(--h-ctl-mini)]')
    expect(secondary.className).toContain('bg-[var(--hover-fill)]')
    expect(secondary.className).toContain('text-[var(--text-secondary)]')
    expect(secondary.className).toContain('hover:enabled:bg-[var(--card-hover)]')
    expect(secondary.className).toContain('hover:enabled:border-[var(--border-hover)]')

    rerender(<Button variant="ghost">Back</Button>)
    expect(screen.getByRole('button', { name: 'Back' }).className).toContain('btn-ghost')

    rerender(<Button variant="danger" armed>Delete</Button>)
    const danger = screen.getByRole('button', { name: 'Delete' })
    expect(danger.className).toContain('hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]')
    expect(danger.className).toContain('bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]')

    rerender(<Button variant="danger-solid" icon={() => <svg aria-hidden="true" />}>Delete</Button>)
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('text-white')

    rerender(<Button variant="icon" icon={() => <svg aria-hidden="true" />} aria-label="Close" disabled />)
    const icon = screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement
    expect(icon.disabled).toBe(true)
    expect(icon.className).not.toMatch(/(?:^|\s)(?:px-|gap-)/)
    expect(icon.className).toContain('w-6')
    expect(icon.className).toContain('p-0')
    expect(icon.parentElement?.getAttribute('data-tooltip')).toBe('Close')
  })

  it('icon Button variants render their accessible name as a tooltip label', () => {
    const { container } = render(<Button variant="icon" icon={() => <svg aria-hidden="true" />} aria-label="Refresh usage" />)
    expect(container.querySelector('[data-tooltip="Refresh usage"]')).not.toBeNull()
  })

  it('Count omits zero by default, shows metric zero and adds no punctuation', () => {
    const { rerender, container } = render(<span>Routines<Count value={0} /></span>)
    expect(container.textContent).toBe('Routines')
    rerender(<span>Processed<Count value={0} showZero /></span>)
    expect(container.textContent).toBe('Processed0')
    rerender(<span>Tasks<Count value={12} /></span>)
    expect(container.textContent).toBe('Tasks12')
    expect(container.textContent).not.toMatch(/[().·]/)
    expect(container.querySelector('span[aria-hidden="true"]')?.className).toBe('inline-block w-[var(--space-1-5)]')
    expect(container.querySelector('span:not([aria-hidden])')?.className).not.toContain('inline-flex')
    expect(container.querySelector('span:not([aria-hidden])')?.className).not.toContain('gap-')
  })

  it('StatusLabel exposes a static verdict dot without hidden label text', () => {
    const { container, rerender, unmount } = render(<StatusLabel status="Done" variant="dot" />)
    const dot = screen.getByRole('img', { name: 'Done' })
    expect(dot.textContent).toBe('')
    expect(dot.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain('var(--ok)')
    rerender(<StatusLabel status="Stalled" variant="dot" />)
    expect(screen.getByRole('img', { name: 'Stalled' })).toBeTruthy()
    expect(container.innerHTML).not.toContain('animate')
    unmount()
  })

  it('StatusLabel renders the fixed words and dot for every state', () => {
    for (const status of STATUS_LABELS) {
      const { unmount } = render(<StatusLabel status={status} />)
      const label = screen.getByLabelText(status)
      expect(label.textContent).toBe(status)
      expect(label.querySelector('[aria-hidden="true"]')?.className).toContain('rounded-full')
      if (status === 'Idle' || status === 'Paused' || status === 'Missing' || status === 'Not seen') {
        expect(label.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain('transparent')
      }
      unmount()
    }
    expect(STATUS_LABELS).toContain('Connected')
    expect(STATUS_LABELS).toContain('Reconnecting')
  })

  it('shows connection state and a test failure inline, with a working cell action', () => {
    const onClick = vi.fn()
    render(<ConnectionCell status="Failed" reason="npx was not found on PATH" server="github" agent="Claude Code" onClick={onClick} />)
    expect(screen.getByLabelText('Failed')).toBeTruthy()
    expect(screen.getByText('npx').tagName).toBe('CODE')
    expect(screen.getByText(/was not found on PATH/)).toBeTruthy()
    screen.getByRole('button', { name: 'turn off github for Claude Code' }).click()
    expect(onClick).toHaveBeenCalledOnce()
  })
})
