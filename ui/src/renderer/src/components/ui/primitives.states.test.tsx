// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button, Count, STATUS_LABELS, StatusLabel, TextInput } from './index'
import { variants } from './variants'

const textClass = variants('base', { tone: { quiet: 'muted', loud: 'strong' } }, { tone: 'quiet' })

// @ts-expect-error invalid variant keys are rejected
textClass({ tone: 'unknown' })
// @ts-expect-error Button variants are a closed union
const invalidButtonVariant = <Button variant="tertiary">Save</Button>
// @ts-expect-error icon buttons require an accessible label
const unnamedIconButton = <Button variant="icon" icon={() => <svg />} />
// @ts-expect-error danger-solid buttons require an icon
const unlabeledButton = <Button variant="danger-solid">Delete</Button>
// @ts-expect-error a TextInput is text or a secret, nothing else
const numberInput = <TextInput type="number" />
void numberInput
// @ts-expect-error status values come from the fixed vocabulary
const unknownStatus = <StatusLabel status="Offline" />
void unnamedIconButton
void invalidButtonVariant
void unlabeledButton
void unknownStatus

describe('components/ui primitives', () => {
  it('TextInput keeps its role, width and face, and passes layout and aria through', () => {
    render(<TextInput aria-label="Bot token" type="password" mono width="full" className="flex-1" defaultValue="x" />)
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
  })

  it('Count omits zero by default, shows metric zero and adds no punctuation', () => {
    const { rerender, container } = render(<span>Routines<Count value={0} /></span>)
    expect(container.textContent).toBe('Routines')
    rerender(<span>Processed<Count value={0} showZero /></span>)
    expect(container.textContent).toBe('Processed0')
    rerender(<span>Tasks<Count value={12} /></span>)
    expect(container.textContent).toBe('Tasks12')
    expect(container.textContent).not.toMatch(/[().·]/)
    expect(container.querySelector('span[aria-hidden="true"]')?.className).toBe('w-[var(--space-1-5)]')
    expect(container.querySelector('span:not([aria-hidden])')?.className).not.toContain('gap-')
  })

  it('StatusLabel renders the fixed words and dot for every state', () => {
    for (const status of STATUS_LABELS) {
      const { unmount } = render(<StatusLabel status={status} />)
      const label = screen.getByLabelText(status)
      expect(label.textContent).toBe(status)
      expect(label.querySelector('[aria-hidden="true"]')?.className).toContain('rounded-full')
      if (status === 'Idle' || status === 'Paused' || status === 'Missing') {
        expect(label.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain('transparent')
      }
      unmount()
    }
  })
})
