// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { loadInspectorTabs } from '../scmPanel'
import { routeBrowserOpenRequest } from './browserOpenRequest'
beforeEach(() => localStorage.clear())
it('restores migrated grid browser URLs into rendered inspector tabs', () => {
  localStorage.setItem('tr-side:/work', JSON.stringify({ tabs: [{kind:'browser', id:'migrated', url:'http://localhost:3000'}], active:0 }))
  expect(loadInspectorTabs('/work').openTabs).toContain('browser:migrated')
})
it('opens the requested URL with the exact host chosen surface id', () => {
  const reveal = vi.fn(), open = vi.fn()
  ;routeBrowserOpenRequest({workspaceId:'/work', action:'open', surfaceId:'host-tab', url:'https://example.test'}, reveal, open)
  expect(open).toHaveBeenCalledWith('host-tab', 'https://example.test', '/work', 'open')
})
it('reveals an exact saved tab in another workspace without replacing its URL', () => {
  localStorage.setItem('tr-side:/other', JSON.stringify({tabs:[{kind:'browser',id:'target',url:'https://saved.test'}],active:0}))
  const reveal = vi.fn(), open = vi.fn()
  ;routeBrowserOpenRequest({workspaceId:'/other',action:'reveal',surfaceId:'target'}, reveal, open)
  expect(reveal).toHaveBeenCalledWith('/other')
  expect(open).toHaveBeenCalledWith('target', '', '/other', 'reveal')
})

it('closes only the requested persisted tab without switching workspaces', () => {
  localStorage.setItem('tr-inspector-tabs:/other', JSON.stringify({openTabs:['browser:one','browser:two'],active:'browser:two'}))
  const reveal = vi.fn(), open = vi.fn()
  routeBrowserOpenRequest({workspaceId:'/other',action:'close',surfaceId:'two'},reveal,open)
  expect(loadInspectorTabs('/other')).toEqual({openTabs:['browser:one'],active:'browser:one'})
  expect(reveal).not.toHaveBeenCalled()
  expect(open).toHaveBeenCalledWith('two','','/other','close')
})
it('ignores unknown reveal and close ids without opening a replacement', () => {
  const reveal = vi.fn(), open = vi.fn()
  for (const action of ['reveal','close'] as const) routeBrowserOpenRequest({workspaceId:'/empty',action,surfaceId:'missing'},reveal,open)
  expect(reveal).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})
