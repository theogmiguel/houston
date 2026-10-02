// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { store, dropWorkspaceBuffers } from './bufferStore'
import { ensureBuffer, getBuffer, saveBuffer, checkBufferRevision, overwriteBuffer, contentHash } from './buffers'
const bridge = vi.hoisted(() => ({ readFile: vi.fn(), statFile: vi.fn(), writeFileChecked: vi.fn(), writeFile: vi.fn() }))
vi.mock('../houston/bridge', () => bridge)
beforeEach(() => { dropWorkspaceBuffers('/ws'); vi.clearAllMocks(); bridge.readFile.mockResolvedValue('original\r\n'); bridge.statFile.mockResolvedValue({ mtimeMs: 1 }); bridge.writeFileChecked.mockResolvedValue('a'.repeat(64)) })
const dirty = async () => {
  await ensureBuffer('/ws', '/ws/file', () => {})
  const entry = store.get('/ws\0/ws/file')!
  entry.buf = { ...entry.buf, state: EditorState.create({ doc: 'edited' }), dirty: true }
}
describe('atomic checked editor saves', () => {
  it('sends the hash of exact original disk bytes and keeps the returned revision', async () => {
    await dirty()
    expect(await saveBuffer('/ws', '/ws/file')).toBe('saved')
    expect(bridge.writeFileChecked).toHaveBeenCalledWith('/ws/file', 'edited', await contentHash('original\r\n'))
    expect(getBuffer('/ws', '/ws/file')?.sha256).toBe('a'.repeat(64))
  })
  it('surfaces a hash conflict even when mtime has not changed', async () => {
    await dirty()
    bridge.writeFileChecked.mockRejectedValue(new Error('FILE_SAVE_CONFLICT expected original hash, got changed hash'))
    expect(await saveBuffer('/ws', '/ws/file')).toBe('conflict')
    expect(getBuffer('/ws', '/ws/file')).toMatchObject({ dirty: true, conflict: true })
  })
  it('preserves edits made while a checked save is in flight', async () => {
    await dirty()
    let finish!: (hash: string) => void
    bridge.writeFileChecked.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
    const saving = saveBuffer('/ws', '/ws/file')
    await vi.waitFor(() => expect(finish).toBeDefined())
    const entry = store.get('/ws\0/ws/file')!
    entry.buf = { ...entry.buf, state: EditorState.create({ doc: 'newer edit' }), dirty: true }
    finish('b'.repeat(64))
    await saving
    expect(getBuffer('/ws', '/ws/file')).toMatchObject({ dirty: true, sha256: 'b'.repeat(64) })
  })
  it('focus recheck marks dirty files conflicted without replacing their text', async () => {
    await dirty()
    bridge.readFile.mockResolvedValue('external')
    await checkBufferRevision('/ws', '/ws/file')
    expect(getBuffer('/ws', '/ws/file')?.conflict).toBe(true)
    expect(getBuffer('/ws', '/ws/file')?.state.doc.toString()).toBe('edited')
  })
  it('reloads a clean focused buffer from the single checked read', async () => {
    await ensureBuffer('/ws', '/ws/file', () => {})
    bridge.readFile.mockClear().mockResolvedValue('external')
    await checkBufferRevision('/ws', '/ws/file')
    expect(bridge.readFile).toHaveBeenCalledTimes(1)
    expect(getBuffer('/ws', '/ws/file')?.state.doc.toString()).toBe('external')
  })
  it('preserves typing while the focus read is pending', async () => {
    await ensureBuffer('/ws', '/ws/file', () => {})
    let finish!: (content: string) => void
    bridge.readFile.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
    const checking = checkBufferRevision('/ws', '/ws/file')
    const entry = store.get('/ws\0/ws/file')!
    entry.buf = { ...entry.buf, state: EditorState.create({ doc: 'typed' }), dirty: true }
    finish('external')
    await checking
    expect(getBuffer('/ws', '/ws/file')?.state.doc.toString()).toBe('typed')
    expect(getBuffer('/ws', '/ws/file')?.conflict).toBe(true)
  })
  it('ignores a focus read superseded by a successful save', async () => {
    await dirty()
    let finish!: (content: string) => void
    bridge.readFile.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
    const checking = checkBufferRevision('/ws', '/ws/file')
    await saveBuffer('/ws', '/ws/file')
    finish('old external')
    await checking
    expect(getBuffer('/ws', '/ws/file')?.state.doc.toString()).toBe('edited')
    expect(getBuffer('/ws', '/ws/file')?.conflict).toBe(false)
  })
  it('explicit overwrite still checks the newly read disk revision atomically', async () => {
    await dirty()
    bridge.readFile.mockResolvedValue('external')
    await overwriteBuffer('/ws', '/ws/file')
    expect(bridge.writeFileChecked).toHaveBeenCalledWith('/ws/file', 'edited', await contentHash('external'))
  })
})
