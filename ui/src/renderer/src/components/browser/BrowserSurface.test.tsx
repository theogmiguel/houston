// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserSurface } from './BrowserSurface'
const native = vi.hoisted(() => ({mount: vi.fn()}))
vi.mock('../BrowserViewport', () => ({BrowserViewport: ({id, url, children}: {id: string; url: string; children: React.ReactNode}) => { native.mount(id, url); return <div data-testid="native-surface">{children}</div> }}))
afterEach(() => {cleanup(); localStorage.clear(); native.mount.mockClear()})
it('loads the requested URL into the native surface whose id is the panel tab id', () => {
  render(<BrowserSurface workspace="/work" tabId="host-chosen" initialUrl="https://requested.test/" active onTitleChange={() => {}} />)
  expect(native.mount).toHaveBeenCalledWith('host-chosen', 'https://requested.test/')
  expect(localStorage.getItem('tr-inspector-browser-url:/work:host-chosen')).toBe('https://requested.test/')
  expect(screen.queryByText('Local servers')).toBeNull()
})
it('starts an empty tab with workspace recents and local servers', () => {
  localStorage.setItem('tr-browser-recents:/work', JSON.stringify([{url:'https://recent.test/',title:'Recent',favicon:null}]))
  render(<BrowserSurface workspace="/work" tabId="empty" active onTitleChange={() => {}} />)
  expect(screen.getByText('Recently used')).toBeTruthy()
  expect(screen.getByText('Recent')).toBeTruthy()
  expect(native.mount).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Recent'))
  expect(native.mount).toHaveBeenCalledWith('empty', 'https://recent.test/')
})
it('labels local and insecure pages and exits fullscreen with Escape', () => {
  const view = render(<BrowserSurface workspace="/work" tabId="local" initialUrl="http://localhost:3000/" active onTitleChange={() => {}} />)
  expect(screen.getByText('local')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', {name:'Full screen'}))
  expect(screen.getByRole('dialog', {name:'Browser — full screen'})).toBeTruthy()
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})))
  expect(screen.queryByRole('dialog')).toBeNull()
  view.unmount()
  render(<BrowserSurface workspace="/work" tabId="insecure" initialUrl="http://remote.test/" active onTitleChange={() => {}} />)
  expect(screen.getByText('not secure')).toBeTruthy()
})
