// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { EditorView as CmView } from '@codemirror/view'
import { ensureBuffer, getBuffer, dirtyBufferPaths, dropWorkspaceBuffers, setBufferWrap } from './buffers'

describe('dirtyBufferPaths', () => {
  beforeEach(() => {
    ;(window as unknown as { houston: unknown }).houston = {
      readFile: async (): Promise<string> => 'hello',
      statFile: async (): Promise<{ mtimeMs: number }> => ({ mtimeMs: 1 })
    }
  })

  async function open(dir: string, path: string, edit: boolean): Promise<void> {
    await ensureBuffer(dir, path, () => {})
    if (!edit) return
    const buf = getBuffer(dir, path)
    if (!buf) throw new Error(`buffer missing after ensureBuffer: ${dir} ${path}`)
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new CmView({ state: buf.state, parent })
    view.dispatch({ changes: { from: 0, insert: 'x' } })
    view.destroy()
    parent.remove()
  }

  it('reports only unsaved files, scoped to one workspace', async () => {
    await open('/tmp/ws-a', 'clean.ts', false)
    await open('/tmp/ws-a', 'b.ts', true)
    await open('/tmp/ws-a', 'a.ts', true)
    await open('/tmp/ws-b', 'elsewhere.ts', true)

    expect(dirtyBufferPaths('/tmp/ws-a')).toEqual(['a.ts', 'b.ts'])
    expect(dirtyBufferPaths('/tmp/ws-b')).toEqual(['elsewhere.ts'])

    dropWorkspaceBuffers('/tmp/ws-a')
    expect(dirtyBufferPaths('/tmp/ws-a')).toEqual([])
    expect(dirtyBufferPaths('/tmp/ws-b')).toEqual(['elsewhere.ts'])
    dropWorkspaceBuffers('/tmp/ws-b')
  })

  it('returns empty for a workspace with nothing open', () => {
    expect(dirtyBufferPaths('/tmp/never-opened')).toEqual([])
  })

  it('does not match a workspace that is a string prefix of another', async () => {
    await open('/tmp/proj', 'x.ts', true)
    expect(dirtyBufferPaths('/tmp/proj')).toEqual(['x.ts'])
    expect(dirtyBufferPaths('/tmp/pro')).toEqual([])
    dropWorkspaceBuffers('/tmp/proj')
  })

  it('persists the word-wrap choice for the user across file buffers', async () => {
    localStorage.clear()
    await ensureBuffer('/tmp/ws-a', '/tmp/ws-a/readme.md', () => {})
    setBufferWrap('/tmp/ws-a', '/tmp/ws-a/readme.md', false)
    dropWorkspaceBuffers('/tmp/ws-a')
    await ensureBuffer('/tmp/ws-b', '/tmp/ws-b/source.ts', () => {})
    expect(getBuffer('/tmp/ws-b', '/tmp/ws-b/source.ts')?.wrap).toBe(false)
    dropWorkspaceBuffers('/tmp/ws-b')
  })
})

it('invalidates a pending read when its workspace is removed', async () => {
  let resolve!: (content: string) => void
  window.houston.readFile = () => new Promise<string>(r => { resolve = r })
  const pending = ensureBuffer('/tmp/removed', '/tmp/removed/a.txt', () => {})
  dropWorkspaceBuffers('/tmp/removed')
  resolve('late')
  await expect(pending).rejects.toThrow('closed')
  expect(getBuffer('/tmp/removed', '/tmp/removed/a.txt')).toBeUndefined()
})

it('final-owner release discards edits and reopening reads disk again', async () => {
  window.houston.readFile = async () => 'disk'
  const { retainBuffer, noteUpdate } = await import('./bufferStore')
  const release = retainBuffer('/tmp/close', '/tmp/close/a.txt')
  const buf = await ensureBuffer('/tmp/close', '/tmp/close/a.txt', () => {})
  noteUpdate('/tmp/close', '/tmp/close/a.txt', buf.state.update({ changes: { from: 0, to: buf.state.doc.length, insert: 'abandoned' } }).state, true)
  release()
  await Promise.resolve()
  expect(getBuffer('/tmp/close', '/tmp/close/a.txt')).toBeUndefined()
  const reopened = await ensureBuffer('/tmp/close', '/tmp/close/a.txt', () => {})
  expect(reopened.state.doc.toString()).toBe('disk')
  dropWorkspaceBuffers('/tmp/close')
})

it('a final close invalidates its pending read without deleting the reopened load', async () => {
  const { retainBuffer } = await import('./bufferStore')
  const release = retainBuffer('/tmp/pending-close', '/tmp/pending-close/a.txt')
  let resolve!: (content: string) => void
  window.houston.readFile = () => new Promise<string>(r => { resolve = r })
  const pending = ensureBuffer('/tmp/pending-close', '/tmp/pending-close/a.txt', () => {})
  const rejected = expect(pending).rejects.toThrow('closed')
  release()
  await Promise.resolve()
  window.houston.readFile = async () => 'reopened'
  const reopened = await ensureBuffer('/tmp/pending-close', '/tmp/pending-close/a.txt', () => {})
  resolve('abandoned read')
  await rejected
  expect(getBuffer('/tmp/pending-close', '/tmp/pending-close/a.txt')?.state).toBe(reopened.state)
  dropWorkspaceBuffers('/tmp/pending-close')
})
