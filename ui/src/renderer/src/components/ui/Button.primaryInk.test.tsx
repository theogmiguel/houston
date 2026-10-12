// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from './Button'

afterEach(cleanup)

describe('primary button ink', () => {
  it('uses the white label on the primary fill, like the launch and commit buttons', () => {
    render(<Button variant="primary">Show pairing code</Button>)
    const cls = screen.getByRole('button', { name: 'Show pairing code' }).className
    expect(cls).toContain('text-[var(--primary-foreground)]')
    expect(cls).not.toContain('text-[var(--accent-ink)]')
    expect(cls).toContain('bg-[var(--primary-fill)]')
  })
})
