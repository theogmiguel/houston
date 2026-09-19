import { describe, expect, it } from 'vitest'
import { groupNotices, startOfDay, type Notice } from './noticeFeed'
import type { NoticeSeverity } from './components/noticeSeverity'


const NOW = new Date('2026-08-27T14:30:00').getTime()
const MIDNIGHT = startOfDay(NOW)

let seq = 0
function notice(over: Partial<Notice> & { severity?: NoticeSeverity }): Notice {
  seq += 1
  return {
    id: seq,
    session: 1,
    title: `n${seq}`,
    dir: '/proj',
    text: '',
    time: NOW,
    read: false,
    severity: 'completed',
    ...over
  }
}

describe('groupNotices — the bell panel sections', () => {
  it('puts an unanswered question first, ahead of newer finished work', () => {
    const asked = notice({ severity: 'needs-input', time: MIDNIGHT + 1000 })
    const done = notice({ severity: 'completed', time: NOW })
    const sections = groupNotices([done, asked], NOW)
    expect(sections.map((s) => s.title)).toEqual(['Needs you', 'Today'])
    expect(sections[0]?.notices).toEqual([asked])
    expect(sections[0]?.needsYou).toBe(true)
    expect(sections[1]?.notices).toEqual([done])
    expect(sections[1]?.needsYou).toBe(false)
  })

  it('splits the rest at local midnight', () => {
    const today = notice({ time: MIDNIGHT })
    const earlier = notice({ time: MIDNIGHT - 1 })
    const sections = groupNotices([today, earlier], NOW)
    expect(sections.map((s) => s.title)).toEqual(['Today', 'Earlier'])
    expect(sections[0]?.notices).toEqual([today])
    expect(sections[1]?.notices).toEqual([earlier])
  })

  it('drops empty sections rather than rendering a header over nothing', () => {
    expect(groupNotices([], NOW)).toEqual([])
    expect(groupNotices([notice({ time: NOW })], NOW).map((s) => s.title)).toEqual(['Today'])
  })

  it('a READ needs-input row leaves "Needs you" for its day bucket', () => {
    const answered = notice({ severity: 'needs-input', read: true, time: NOW })
    expect(groupNotices([answered], NOW).map((s) => s.title)).toEqual(['Today'])
  })

  it('preserves the caller’s order inside each section', () => {
    const a = notice({ time: NOW })
    const b = notice({ time: NOW - 1000 })
    const c = notice({ time: NOW - 2000 })
    expect(groupNotices([a, b, c], NOW)[0]?.notices).toEqual([a, b, c])
  })
})
