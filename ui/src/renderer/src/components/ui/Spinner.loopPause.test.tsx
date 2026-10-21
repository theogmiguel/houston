// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkingSpinner } from './Spinner'

afterEach(cleanup)

describe('WorkingSpinner motion pause', () => {
  it('carries loop-anim, the class the paused-document rule targets', () => {
    const { container } = render(<WorkingSpinner label="Working" />)
    const spinner = container.querySelector('span')
    expect(spinner?.classList.contains('loop-anim')).toBe(true)
    expect(spinner?.classList.contains('motion-reduce:animate-none')).toBe(true)
  })

  it('a paused document stops the spinner: the pause rule covers loop-anim', () => {
    const keyframes = readFileSync(join(__dirname, '../../keyframes.css'), 'utf8')
    expect(keyframes).toContain('html[data-motion-paused] .loop-anim')
    expect(keyframes).toContain('animation-play-state: paused')
  })
})
