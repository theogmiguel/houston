// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILES_TABS_MAX, openFileTab, useFileTabs, type FileTab } from './useFileTabs'
import { bufferKey, notify, store } from '../../editor/bufferStore'
import { EditorState } from '@codemirror/state'
vi.mock('../../editor/useEditorSurface', () => ({ useEditorSurface: () => ({ viewRef: { current: null }, ready: false }) }))
beforeEach(() => { localStorage.clear(); store.clear() })
afterEach(cleanup)
const tab = (path: string, preview = false): FileTab => ({ path, preview, missing: false })
const clean = () => false

describe('Files tabs bound', () => {
  it('replaces a clean preview and preserves pinned files', () => {
    const tabs = [tab('/ws/a', false), tab('/ws/b', true)]
    expect(openFileTab(tabs, '/ws/c', true, clean)).toEqual([tabs[0], tab('/ws/c', true)])
    expect(openFileTab(tabs, '/ws/b', false, clean)?.[1].preview).toBe(false)
  })
  it('never replaces a dirty preview before its buffer subscription pins it', () => {
    expect(openFileTab([tab('/ws/a', true)], '/ws/b', true, () => true)).toEqual([tab('/ws/a', true), tab('/ws/b', true)])
  })
  it('evicts the oldest clean unpinned tab at twelve files', () => {
    const tabs = Array.from({ length: FILES_TABS_MAX }, (_, index) => tab(`/ws/${index}`, index < 2))
    const next = openFileTab(tabs, '/ws/new', false, (path) => path === '/ws/0')!
    expect(next).toHaveLength(FILES_TABS_MAX)
    expect(next.some((item) => item.path === '/ws/0')).toBe(true)
    expect(next.some((item) => item.path === '/ws/1')).toBe(false)
    expect(next.at(-1)).toEqual(tab('/ws/new'))
  })
  it('refuses when every tab is dirty or pinned', () => {
    const tabs = Array.from({ length: FILES_TABS_MAX }, (_, index) => tab(`/ws/${index}`, true))
    expect(openFileTab(tabs, '/ws/new', false, () => true)).toBeNull()
    expect(openFileTab(tabs.map((item) => ({ ...item, preview: false })), '/ws/new', false, clean)).toBeNull()
  })
  it('keeps the active file on refusal and reports the limit, count and requested path', () => {
    const { result } = renderHook(() => useFileTabs('/ws'))
    act(() => { for (let index = 0; index < FILES_TABS_MAX; index++) result.current.pinFile(`/ws/${index}`) })
    act(() => result.current.pinFile('/ws/thirteenth'))
    expect(result.current.activePath).toBe('/ws/11')
    expect(result.current.tabError).toContain('limit 12')
    expect(result.current.tabError).toContain('current count 12')
    expect(result.current.tabError).toContain('/ws/thirteenth')
  })
  it('pins an edited preview and confirms before closing it', () => {
    const { result } = renderHook(() => useFileTabs('/ws'))
    act(() => result.current.previewFile('/ws/a'))
    store.set(bufferKey('/ws', '/ws/a'), { buf: { state: EditorState.create({ doc: 'edited' }), dirty: true, conflict: false, wrap: false, mtimeMs: null, lineEnding: 'LF' }, extensions: [] })
    act(() => notify(bufferKey('/ws', '/ws/a')))
    expect(result.current.tabs[0].preview).toBe(false)
    act(() => result.current.requestCloseTab('/ws/a'))
    expect(result.current.confirmClose).toBe('/ws/a')
    expect(result.current.tabs).toHaveLength(1)
  })
})
