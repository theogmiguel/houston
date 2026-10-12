// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useFileTabs } from './useFileTabs'
import { useEditorSurface } from '../../editor/useEditorSurface'
import { getBuffer, dropWorkspaceBuffers, noteUpdate } from '../../editor/bufferStore'
import '../../editor/buffers'

beforeEach(() => {
  localStorage.clear()
  window.houston = {
    readFile: async () => 'disk',
    statFile: async () => ({ mtimeMs: 1 })
  } as unknown as typeof window.houston
})
afterEach(() => { cleanup(); dropWorkspaceBuffers('/lifecycle') })

it('real editor surface and tab share edits through transfer; final Discard reopens disk', async () => {
  const tabs = renderHook(() => useFileTabs('/lifecycle'))
  act(() => tabs.result.current.pinFile('/lifecycle/a.txt'))
  await waitFor(() => expect(tabs.result.current.surface.ready).toBe(true), { timeout: 10000 })
  const original = getBuffer('/lifecycle', '/lifecycle/a.txt')!
  act(() => noteUpdate('/lifecycle', '/lifecycle/a.txt', original.state.update({ changes: { from: 0, insert: 'edit ' } }).state, true))
  const detached = renderHook(() => useEditorSurface('/lifecycle', '/lifecycle/a.txt'))
  await waitFor(() => expect(detached.result.current.ready).toBe(true), { timeout: 10000 })
  await act(async () => tabs.result.current.transferTab('/lifecycle/a.txt'))
  expect(detached.result.current.buf?.state.doc.toString()).toBe('edit disk')
  act(() => tabs.result.current.pinFile('/lifecycle/a.txt'))
  await waitFor(() => expect(tabs.result.current.surface.ready).toBe(true), { timeout: 10000 })
  detached.unmount()
  act(() => tabs.result.current.requestCloseTab('/lifecycle/a.txt'))
  await act(async () => tabs.result.current.discardAndClose())
  expect(getBuffer('/lifecycle', '/lifecycle/a.txt')).toBeUndefined()
  act(() => tabs.result.current.pinFile('/lifecycle/a.txt'))
  await waitFor(() => expect(tabs.result.current.surface.ready).toBe(true), { timeout: 10000 })
  expect(tabs.result.current.activeBuf?.state.doc.toString()).toBe('disk')
}, 30000)

it('a saved editor layout retains a document across surface unmounts and releases it on logical close', async () => {
  const { useLayoutDocumentOwners } = await import('../../editor/useLayoutDocumentOwners')
  const { ensureBuffer } = await import('../../editor/buffers')
  const workspace = [{ path: '/lifecycle' }]
  const layout = { tree: { kind: 'editor' as const, id: 'e1', path: '/lifecycle/a.txt' }, cols: 2 }
  const owner = renderHook(({ layouts }) => useLayoutDocumentOwners(workspace, layouts), {
    initialProps: { layouts: new Map([['/lifecycle::hidden-grid', layout]]) }
  })
  const surface = renderHook(() => useEditorSurface('/lifecycle', '/lifecycle/a.txt'))
  const buf = await ensureBuffer('/lifecycle', '/lifecycle/a.txt', () => {})
  await act(async () => surface.unmount())
  expect(getBuffer('/lifecycle', '/lifecycle/a.txt')?.state).toBe(buf.state)
  await act(async () => owner.rerender({ layouts: new Map() }))
  expect(getBuffer('/lifecycle', '/lifecycle/a.txt')).toBeUndefined()
}, 30000)

it('a hidden Files pane keeps its tab document when another surface closes the same path', async () => {
  const { useLayoutDocumentOwners } = await import('../../editor/useLayoutDocumentOwners')
  const workspace = [{ path: '/lifecycle' }]
  const both = { tree: { kind: 'split' as const, dir: 'row' as const, weights: [0.5, 0.5], children: [{ kind: 'files' as const, id: 'f1' }, { kind: 'files' as const, id: 'f2' }] }, cols: 2 }
  const owner = renderHook(({ layouts }) => useLayoutDocumentOwners(workspace, layouts), { initialProps: { layouts: new Map([['/lifecycle::grid', both]]) } })
  const first = renderHook(() => useFileTabs('/lifecycle', 'f1'))
  const second = renderHook(() => useFileTabs('/lifecycle', 'f2'))
  act(() => { first.result.current.pinFile('/lifecycle/a.txt'); second.result.current.pinFile('/lifecycle/a.txt') })
  await waitFor(() => expect(first.result.current.surface.ready && second.result.current.surface.ready).toBe(true), { timeout: 10000 })
  const original = getBuffer('/lifecycle', '/lifecycle/a.txt')!
  await act(async () => first.unmount())
  await act(async () => second.result.current.requestCloseTab('/lifecycle/a.txt'))
  expect(getBuffer('/lifecycle', '/lifecycle/a.txt')?.state).toBe(original.state)
  const onlySecond = { ...both, tree: { ...both.tree, children: [both.tree.children[1]] } }
  await act(async () => owner.rerender({ layouts: new Map([['/lifecycle::grid', onlySecond]]) }))
  expect(getBuffer('/lifecycle', '/lifecycle/a.txt')).toBeUndefined()
}, 30000)

it('a side Files surface retains its actual subdirectory root until its logical tab closes', async () => {
  const { useLayoutDocumentOwners } = await import('../../editor/useLayoutDocumentOwners')
  const { saveInspectorTabs } = await import('../../scmPanel')
  saveInspectorTabs('/lifecycle', { openTabs: ['files'], active: 'files' })
  renderHook(() => useLayoutDocumentOwners([{ path: '/lifecycle' }], new Map()))
  const surface = renderHook(() => useFileTabs('/lifecycle/sub', 'side:/lifecycle'))
  act(() => surface.result.current.pinFile('/lifecycle/sub/a.txt'))
  await waitFor(() => expect(surface.result.current.surface.ready).toBe(true), { timeout: 10000 })
  const original = getBuffer('/lifecycle/sub', '/lifecycle/sub/a.txt')!
  await act(async () => surface.unmount())
  expect(getBuffer('/lifecycle/sub', '/lifecycle/sub/a.txt')?.state).toBe(original.state)
  await act(async () => saveInspectorTabs('/lifecycle', { openTabs: [], active: null }))
  expect(getBuffer('/lifecycle/sub', '/lifecycle/sub/a.txt')).toBeUndefined()
  dropWorkspaceBuffers('/lifecycle/sub')
}, 30000)
