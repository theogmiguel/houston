// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { SIDE_OPEN_EVENT, openSideBrowser } from './sidePanel'
import { browserTabUrl, loadInspectorTabs, saveInspectorTabs } from './scmPanel'
beforeEach(() => localStorage.clear())
it('migrates every legacy browser tab and its URL into the inspector model once', () => {
  localStorage.setItem('tr-side:/a', JSON.stringify({tabs:[{kind:'browser',id:'one',url:'https://one.test/'},{kind:'browser',id:'two',url:'https://two.test/'}],active:1}))
  expect(loadInspectorTabs('/a')).toEqual({openTabs:['browser:one','browser:two'],active:'browser:two'})
  expect(browserTabUrl('/a','one')).toBe('https://one.test/')
  expect(browserTabUrl('/a','two')).toBe('https://two.test/')
  saveInspectorTabs('/a',{openTabs:[],active:null})
  expect(loadInspectorTabs('/a').openTabs).toEqual([])
  expect(loadInspectorTabs('/b').openTabs).toEqual([])
})
it('opens every URL request with its surface id, workspace and action intact', () => {
  const request = vi.fn()
  window.addEventListener(SIDE_OPEN_EVENT, request)
  openSideBrowser('requested','https://requested.test/','/a')
  expect(request.mock.calls[0][0].detail).toEqual({kind:'browser',id:'requested',url:'https://requested.test/',workspace:'/a',action:'open'})
  window.removeEventListener(SIDE_OPEN_EVENT, request)
})

it('migrates every saved nested inspector page into distinct workspace tabs', () => {
  localStorage.setItem('tr-inspector-tabs:/work', JSON.stringify({openTabs:['files','browser'],active:'browser'}))
  localStorage.setItem('tr-browser-tabs.leaf.inspector', JSON.stringify({tabs:[{id:1,url:'https://one.test/'},{id:2,url:'https://two.test/'}],activeTabId:2}))
  const state = loadInspectorTabs('/work')
  const browsers = state.openTabs.filter((tab) => tab.startsWith('browser:'))
  expect(browsers).toHaveLength(2)
  expect(browsers[0]).not.toBe(browsers[1])
  expect(browserTabUrl('/work', browsers[0].slice(8))).toBe('https://one.test/')
  expect(browserTabUrl('/work', browsers[1].slice(8))).toBe('https://two.test/')
  expect(state.active).toBe(browsers[1])
  expect(loadInspectorTabs('/work')).toEqual(state)
})

it('persists rapid URL opens before the renderer can mount the panel', () => {
  openSideBrowser('one','https://one.test/','/work')
  openSideBrowser('two','https://two.test/','/work')
  expect(loadInspectorTabs('/work').openTabs).toEqual(['browser:one','browser:two'])
  expect(browserTabUrl('/work','one')).toBe('https://one.test/')
  expect(browserTabUrl('/work','two')).toBe('https://two.test/')
})
