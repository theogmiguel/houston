// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadSideState, saveSideState } from './sidePanel'
beforeEach(() => localStorage.clear())
describe('side panel persistence', () => {
  it('pins source control and Files and restores one overview per orchestrator', () => {
    saveSideState('/a', { tabs: [{ kind: 'scm' }, { kind: 'files', root: '/child' }, { kind: 'overview', orchestrator: 9 }], active: 2 })
    expect(loadSideState('/a').active).toBe(2)
    expect(loadSideState('/a').tabs[1]).toEqual({ kind: 'files', root: '/child' })
    expect(loadSideState('/a').tabs[2]).toEqual({ kind: 'overview', orchestrator: 9 })
    expect(loadSideState('/b')).toEqual({ tabs: [{ kind: 'scm' }, { kind: 'files' }], active: 0 })
  })
  it('repairs malformed storage and refuses invalid or duplicate overview identities', () => {
    localStorage.setItem('tr-side:/a', '{')
    expect(loadSideState('/a').active).toBe(0)
    localStorage.setItem('tr-side:/a', JSON.stringify({ tabs: [{ kind: 'overview', orchestrator: 2 }, { kind: 'overview', orchestrator: 2 }, { kind: 'overview', orchestrator: 'bad' }], active: 99 }))
    expect(loadSideState('/a').tabs).toHaveLength(3)
    expect(loadSideState('/a').active).toBe(0)
  })
})
