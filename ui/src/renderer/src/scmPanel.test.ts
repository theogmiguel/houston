// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SCM_TERMINAL_FLOOR,
  SCM_WIDTH_DEFAULT,
  SCM_WIDTH_MIN,
  clampScmWidth,
  loadScmDraft,
  loadScmOpen,
  saveScmDraft,
  saveScmOpen,
  scmWidthMax,
  setScmWidth,
  stepScmWidth,
  resetScmWidthForTests
} from './scmPanel'

beforeEach(() => {
  localStorage.clear()
  resetScmWidthForTests()
})

describe('source control width contract', () => {
  it('opens at 480, floors at 340, and keeps 360 for the terminals', () => {
    expect(clampScmWidth(SCM_WIDTH_DEFAULT, 1500)).toBe(480)
    expect(clampScmWidth(200, 1500)).toBe(SCM_WIDTH_MIN)
    expect(clampScmWidth(2000, 1500)).toBe(1500 - SCM_TERMINAL_FLOOR)
    expect(scmWidthMax(1500)).toBe(1500 - SCM_TERMINAL_FLOOR)
  })

  it('clamps to the available width instead of overflowing a narrow window', () => {
    expect(clampScmWidth(480, 300)).toBe(300)
    expect(clampScmWidth(480, 700)).toBe(SCM_WIDTH_MIN)
    expect(clampScmWidth(480, 0)).toBe(SCM_WIDTH_DEFAULT)
  })

  it('does not store a viewport clamp: a wider window restores the request', () => {
    const requested = 900
    expect(clampScmWidth(requested, 1000)).toBe(640)
    expect(clampScmWidth(requested, 1600)).toBe(900)
  })

  it('steps by 4% of the host, the terminal splitter step, and clamps each press', () => {
    expect(stepScmWidth(480, 1, 1200)).toBe(480 + 48)
    expect(stepScmWidth(480, -1, 1200)).toBe(480 - 48)
    expect(stepScmWidth(SCM_WIDTH_MIN, -1, 1200)).toBe(SCM_WIDTH_MIN)
    expect(stepScmWidth(480, 1, 0)).toBe(480 + Math.round(SCM_WIDTH_DEFAULT * 0.04))
  })
})

describe('source control persistence', () => {
  it('remembers the requested width across a reload', () => {
    setScmWidth(612)
    expect(localStorage.getItem('tr-scm-width')).toBe('612')
  })

  it('remembers whether the panel is open', () => {
    expect(loadScmOpen()).toBe(false)
    saveScmOpen(true)
    expect(loadScmOpen()).toBe(true)
    saveScmOpen(false)
    expect(loadScmOpen()).toBe(false)
  })

  it('keeps an unsent commit message per repo, and drops an empty one', () => {
    saveScmDraft('/repo/a', 'still writing this')
    saveScmDraft('/repo/b', 'other repo draft')
    expect(loadScmDraft('/repo/a')).toBe('still writing this')
    expect(loadScmDraft('/repo/b')).toBe('other repo draft')
    saveScmDraft('/repo/a', '')
    expect(loadScmDraft('/repo/a')).toBe('')
    expect(localStorage.getItem('tr-scm-draft:/repo/a')).toBeNull()
  })
})
