// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenSkillStory } from './navStories'
afterEach(() => { cleanup(); vi.useRealTimers() })
it('leaves the default Skills capture closed and opens only the detail variant', () => {
  vi.useFakeTimers()
  const click = vi.fn()
  const { rerender } = render(<OpenSkillStory open={false}><button onClick={click}>ui-tokens</button></OpenSkillStory>)
  vi.advanceTimersByTime(200)
  expect(click).not.toHaveBeenCalled()
  rerender(<OpenSkillStory open><button onClick={click}>ui-tokens</button></OpenSkillStory>)
  vi.advanceTimersByTime(200)
  expect(click).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'ui-tokens' })).toBeTruthy()
})
