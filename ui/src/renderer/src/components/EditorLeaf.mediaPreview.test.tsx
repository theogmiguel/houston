// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorNode } from '../layout/tree'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const { EditorLeaf } = await import('./EditorLeaf')
await import('./EditorSurface')

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

describe('EditorLeaf media/binary preview (Phase 6 item 4 batches 1 and 3a)', () => {
  let container: HTMLDivElement
  let root: Root
  let readFile: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>

  beforeEach(() => {
    readFile = vi.fn<(path: string) => Promise<string>>().mockResolvedValue('hello')
    ;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
      readFile,
      statFile: vi.fn().mockResolvedValue({ mtimeMs: 1 }),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_read_media') return new Uint8Array([1, 2, 3, 4]).buffer
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    let urlCounter = 0
    URL.createObjectURL = vi.fn(() => `blob:test-${++urlCounter}`)
    URL.revokeObjectURL = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function preview(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`)
  }

  async function mount(path: string): Promise<void> {
    const node: EditorNode = { kind: 'editor', id: 'e1', path }
    await act(async () => {
      root.render(
        <EditorLeaf node={node} workspaceDir="/ws" onClose={() => {}} onHeaderPointerDown={() => {}} onSplit={() => {}} />
      )
    })
    await flush()
  }

  it('renders an inline image preview for a known image extension, without ever calling readFile', async () => {
    await mount('/ws/photo.png')
    expect(preview('editor-preview-image')).not.toBeNull()
    expect(preview('editor-preview-image')?.querySelector('img')?.getAttribute('src')).toMatch(
      /^blob:/
    )
    expect(preview('editor-preview-unsupported')).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith('fs_read_media', { filePath: '/ws/photo.png' })
  })

  it('renders an inline video preview for a known video extension', async () => {
    await mount('/ws/clip.mp4')
    expect(preview('editor-preview-video')).not.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('renders an inline audio preview for a known audio extension', async () => {
    await mount('/ws/track.mp3')
    expect(preview('editor-preview-audio')).not.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('still shows the unsupported block for a known-binary extension (e.g. a compiled library)', async () => {
    await mount('/ws/lib.so')
    expect(preview('editor-preview-unsupported')).not.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('never renders two preview blocks at once when switching binary -> media', async () => {
    await mount('/ws/lib.so')
    expect(preview('editor-preview-unsupported')).not.toBeNull()
    await mount('/ws/photo.png')
    const blocks = container.querySelectorAll('[data-testid^="editor-preview-"]')
    expect(blocks.length, 'exactly one preview block may be mounted').toBe(1)
    expect(preview('editor-preview-image')).not.toBeNull()
  })

  it('an unknown extension still opens as a normal text buffer -- unchanged case', async () => {
    await mount('/ws/main.rs')
    expect(readFile).toHaveBeenCalledWith('/ws/main.rs')
    expect(preview('editor-preview-unsupported')).toBeNull()
    const host = container.querySelector('[data-testid="cm-host"]') as HTMLElement
    expect(host.style.display).not.toBe('none')
  })

  it('opens .svg through the ordinary read path, not the unsupported block', async () => {
    await mount('/ws/icon.svg')
    expect(readFile).toHaveBeenCalledWith('/ws/icon.svg')
    expect(preview('editor-preview-unsupported')).toBeNull()
    const host = container.querySelector('[data-testid="cm-host"]') as HTMLElement
    expect(host.style.display).not.toBe('none')
  })

  it('routes the too-large refusal to a state carrying the real size and cap', async () => {
    readFile.mockRejectedValueOnce(
      new Error('file too large to edit: /ws/big.txt is 3000000 bytes (max 2097152)')
    )
    await mount('/ws/big.txt')
    const block = preview('editor-preview-too-large')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('2.9 MB (max 2 MB)')
  })

  it('routes a UTF-8 decode refusal to the "Unsupported encoding" error state', async () => {
    readFile.mockRejectedValueOnce(new Error('file /ws/weird.foo is not valid UTF-8 text: bad byte'))
    await mount('/ws/weird.foo')
    const block = preview('editor-preview-error')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('Unsupported encoding')
  })
})
