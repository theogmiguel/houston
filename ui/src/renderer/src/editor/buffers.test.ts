// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { EditorView as CmView } from '@codemirror/view'
import { ensureBuffer, getBuffer, dirtyBufferPaths, dropWorkspaceBuffers } from './buffers'

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
})
