// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SidePanel } from './SidePanel'
import { loadInspectorTabs } from '../scmPanel'
const native = vi.hoisted(() => ({invoke: vi.fn(async () => {})}))
vi.mock('../houston/host', () => ({isTauri: () => true}))
vi.mock('@tauri-apps/api/core', () => ({invoke: native.invoke}))
vi.mock('./SourceControlPanel', () => ({SourceControlPanel: () => null, ScmResizeHandle: () => null}))
vi.mock('./browser/BrowserSurface', () => ({BrowserSurface: ({tabId, initialUrl, active}: {tabId:string;initialUrl:string;active:boolean}) => <div data-testid={tabId} data-active={active}>{initialUrl}</div>}))
const props = {workspace:'/work',width:384,onWidth:vi.fn(),onResetWidth:vi.fn(),tab:'changes' as const,onTab:vi.fn(),dir:'/work',client:null,sessions:new Map(),activeSessionId:null,request:null,onReviewChild:vi.fn(),onMoveFile:vi.fn(),onFocusSide:vi.fn(),onFocusGrid:vi.fn()}
afterEach(() => {cleanup();localStorage.clear();native.invoke.mockClear()})
it('keeps two requested URLs in separate tabs and closes only the requested surface', async () => {
  const view = render(<SidePanel {...props} request={{kind:'browser',id:'first',url:'https://first.test/',workspace:'/work'}} />)
  await screen.findByTestId('first')
  view.rerender(<SidePanel {...props} request={{kind:'browser',id:'second',url:'https://second.test/',workspace:'/work'}} />)
  await screen.findByTestId('second')
  expect(screen.getByTestId('first').textContent).toBe('https://first.test/')
  expect(screen.getByTestId('second').textContent).toBe('https://second.test/')
  expect(loadInspectorTabs('/work').openTabs).toEqual(['browser:first','browser:second'])
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('browser_set_active',{id:'second',workspaceId:'/work'}))
  view.rerender(<SidePanel {...props} request={{kind:'browser',id:'first',url:'',workspace:'/work',action:'close'}} />)
  expect(screen.queryByTestId('first')).toBeNull()
  expect(screen.getByTestId('second')).toBeTruthy()
  expect(loadInspectorTabs('/work').openTabs).toEqual(['browser:second'])
})
it('restores the active native target and reveals a different saved tab without loading a URL', async () => {
  localStorage.setItem('tr-inspector-tabs:/work',JSON.stringify({openTabs:['browser:first','browser:second'],active:'browser:second'}))
  localStorage.setItem('tr-inspector-browser-url:/work:first','https://first.test/')
  const view = render(<SidePanel {...props} open={false} />)
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('browser_set_active',{id:'second',workspaceId:'/work'}))
  view.rerender(<SidePanel {...props} open request={{kind:'browser',id:'first',url:'https://ignored.test/',workspace:'/work',action:'reveal'}} />)
  expect((await screen.findByTestId('first')).getAttribute('data-active')).toBe('true')
  expect(screen.getByTestId('first').textContent).toBe('https://first.test/')
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('browser_set_active',{id:'first',workspaceId:'/work'}))
  const tabs = screen.getAllByRole('tab')
  fireEvent.click(tabs[1])
  expect(loadInspectorTabs('/work').active).toBe('browser:second')
})
