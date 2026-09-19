// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import * as bridge from './bridge'

function setTauriPresent(present: boolean): void {
  const win = window as unknown as { __TAURI_INTERNALS__?: unknown }
  if (present) {
    win.__TAURI_INTERNALS__ = {}
  } else {
    delete win.__TAURI_INTERNALS__
  }
}

function stubHouston(): Record<string, ReturnType<typeof vi.fn>> {
  const stub = {
    pickDirectory: vi.fn(),
    pickFile: vi.fn(),
    windowControl: vi.fn(),
    isFocused: vi.fn(),
    setZoomFactor: vi.fn(),
    setBackgroundColor: vi.fn(),
    saveImage: vi.fn(),
    saveReview: vi.fn(),
    openExternal: vi.fn(),
    readDir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    statFile: vi.fn(),
    pathKind: vi.fn(),
    pickerListDirs: vi.fn(),
    listSkills: vi.fn(),
    writeSkill: vi.fn(),
    deleteSkill: vi.fn(),
    homeDir: vi.fn(),
    listShells: vi.fn(),
    getLogsDir: vi.fn(),
    setAllowedRoots: vi.fn(),
    openPath: vi.fn(),
    getPathForFile: vi.fn()
  }
  ;(window as unknown as { houston: typeof stub }).houston = stub
  return stub
}

function stubClipboard(methods: Partial<Record<'read' | 'readText', unknown>>): void {
  Object.defineProperty(navigator, 'clipboard', { value: methods, configurable: true })
}

beforeEach(() => {
  invokeMock.mockReset()
})

afterEach(() => {
  setTauriPresent(false)
  delete (window as unknown as { houston?: unknown }).houston
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('bridge — Tauri branch: command name + exact args object', () => {
  beforeEach(() => setTauriPresent(true))

  it('pickDirectory -> dialog_pick_directory {}', async () => {
    invokeMock.mockResolvedValueOnce('/home/dev/project')
    const result = await bridge.pickDirectory()
    expect(invokeMock).toHaveBeenCalledWith('dialog_pick_directory', {})
    expect(result).toBe('/home/dev/project')
  })

  it('pickFile -> dialog_pick_file { defaultPath }', async () => {
    invokeMock.mockResolvedValueOnce(null)
    const result = await bridge.pickFile('/home/dev')
    expect(invokeMock).toHaveBeenCalledWith('dialog_pick_file', { defaultPath: '/home/dev' })
    expect(result).toBeNull()
  })

  it.each([
    ['close', 'window_close'],
    ['minimize', 'window_minimize'],
    ['maximize', 'window_maximize'],
    ['focus', 'window_focus']
  ] as const)('windowControl(%s) -> %s {}', async (action, command) => {
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.windowControl(action)
    expect(invokeMock).toHaveBeenCalledWith(command, {})
  })

  it('isFocused -> window_is_focused {}', async () => {
    invokeMock.mockResolvedValueOnce(true)
    const result = await bridge.isFocused()
    expect(invokeMock).toHaveBeenCalledWith('window_is_focused', {})
    expect(result).toBe(true)
  })

  it('setZoomFactor -> window_set_zoom { factor }', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.setZoomFactor(1.5)
    expect(invokeMock).toHaveBeenCalledWith('window_set_zoom', { factor: 1.5 })
  })

  it('startDragging -> window_start_dragging {}', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.startDragging()
    expect(invokeMock).toHaveBeenCalledWith('window_start_dragging', {})
  })

  it('setBackgroundColor -> window_set_background_color { hex }', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.setBackgroundColor('#1a2b3c')
    expect(invokeMock).toHaveBeenCalledWith('window_set_background_color', { hex: '#1a2b3c' })
  })

  it('saveImage -> fs_save_image { ext, bytes }, args reversed from the JS signature, bytes untouched', async () => {
    invokeMock.mockResolvedValueOnce('/home/dev/shot.png')
    const bytes = new Uint8Array([1, 2, 3])
    const result = await bridge.saveImage(bytes, 'png')
    expect(invokeMock).toHaveBeenCalledWith('fs_save_image', { ext: 'png', bytes })
    expect(invokeMock.mock.calls[0][1].bytes).toBe(bytes)
    expect(result).toBe('/home/dev/shot.png')
  })

  it('readClipboardImagePath -> clipboard_save_image, returning the host-written path', async () => {
    invokeMock.mockResolvedValueOnce('/home/dev/.houston-dev/pastes/17.png')
    const result = await bridge.readClipboardImagePath()
    expect(invokeMock).toHaveBeenCalledWith('clipboard_save_image', {})
    expect(result).toBe('/home/dev/.houston-dev/pastes/17.png')
  })

  it('readClipboardImagePath passes the host null through as "no image"', async () => {
    invokeMock.mockResolvedValueOnce(null)
    expect(await bridge.readClipboardImagePath()).toBeNull()
  })

  it('readClipboardText -> clipboard_read_text', async () => {
    invokeMock.mockResolvedValueOnce('echo hi')
    expect(await bridge.readClipboardText()).toBe('echo hi')
    expect(invokeMock).toHaveBeenCalledWith('clipboard_read_text', {})
  })

  it('saveReview -> fs_save_review { text }', async () => {
    invokeMock.mockResolvedValueOnce('/home/dev/review.md')
    const result = await bridge.saveReview('some review text')
    expect(invokeMock).toHaveBeenCalledWith('fs_save_review', { text: 'some review text' })
    expect(result).toBe('/home/dev/review.md')
  })

  it('openExternal -> shell_open_external { url }', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.openExternal('https://example.com')
    expect(invokeMock).toHaveBeenCalledWith('shell_open_external', { url: 'https://example.com' })
  })

  it('readDir -> fs_read_directory { dirPath }, field names survive unchanged', async () => {
    const entries = [{ name: 'a.ts', path: '/p/a.ts', dir: false, ignored: false }]
    invokeMock.mockResolvedValueOnce(entries)
    const result = await bridge.readDir('/p')
    expect(invokeMock).toHaveBeenCalledWith('fs_read_directory', { dirPath: '/p' })
    expect(result).toEqual(entries)
  })

  it('readFile -> fs_read_file { filePath }', async () => {
    invokeMock.mockResolvedValueOnce('file contents')
    const result = await bridge.readFile('/p/a.ts')
    expect(invokeMock).toHaveBeenCalledWith('fs_read_file', { filePath: '/p/a.ts' })
    expect(result).toBe('file contents')
  })

  it('readMediaFile -> fs_read_media { filePath }, wraps the ArrayBuffer result', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    invokeMock.mockResolvedValueOnce(bytes.buffer)
    const result = await bridge.readMediaFile('/p/photo.png')
    expect(invokeMock).toHaveBeenCalledWith('fs_read_media', { filePath: '/p/photo.png' })
    expect(result).toEqual(bytes)
  })

  it('deleteAgentSession -> agent_session_delete { sessionId, nativeSessionId }', async () => {
    invokeMock.mockResolvedValueOnce({ sessionId: 5 })
    await bridge.deleteAgentSession(5, '3f2504e0-4f89-11d3-9a0c-0305e82c3301')
    expect(invokeMock).toHaveBeenCalledWith('agent_session_delete', {
      sessionId: 5,
      nativeSessionId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    })
  })

  it('writeFile -> fs_write_file { filePath, content }', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.writeFile('/p/a.ts', 'new contents')
    expect(invokeMock).toHaveBeenCalledWith('fs_write_file', {
      filePath: '/p/a.ts',
      content: 'new contents'
    })
  })

  it('statFile -> fs_stat { targetPath }, mtimeMs survives unchanged', async () => {
    invokeMock.mockResolvedValueOnce({ mtimeMs: 12345.678 })
    const result = await bridge.statFile('/p/a.ts')
    expect(invokeMock).toHaveBeenCalledWith('fs_stat', { targetPath: '/p/a.ts' })
    expect(result).toEqual({ mtimeMs: 12345.678 })
  })

  it('statFile -> null passes through unchanged', async () => {
    invokeMock.mockResolvedValueOnce(null)
    const result = await bridge.statFile('/missing')
    expect(result).toBeNull()
  })

  it('pathKind -> fs_exists { targetPath }', async () => {
    invokeMock.mockResolvedValueOnce('dir')
    const result = await bridge.pathKind('/p')
    expect(invokeMock).toHaveBeenCalledWith('fs_exists', { targetPath: '/p' })
    expect(result).toBe('dir')
  })

  it('pickerListDirs -> fs_picker_list_dirs { path }', async () => {
    invokeMock.mockResolvedValueOnce(['sub1', 'sub2'])
    const result = await bridge.pickerListDirs('/p')
    expect(invokeMock).toHaveBeenCalledWith('fs_picker_list_dirs', { path: '/p' })
    expect(result).toEqual(['sub1', 'sub2'])
  })

  it('homeDir -> system_get_home_dir {}', async () => {
    invokeMock.mockResolvedValueOnce('/home/dev')
    const result = await bridge.homeDir()
    expect(invokeMock).toHaveBeenCalledWith('system_get_home_dir', {})
    expect(result).toBe('/home/dev')
  })

  it('listSkills -> system_list_skills { projectDir }, field names survive unchanged', async () => {
    const skills = [
      {
        agent: 'claude',
        name: 'security-audit',
        description: 'Audits things',
        invoke: '/security-audit',
        source: 'user',
        path: '/home/dev/.claude/skills/security-audit/SKILL.md'
      }
    ]
    invokeMock.mockResolvedValueOnce(skills)
    const result = await bridge.listSkills('/proj')
    expect(invokeMock).toHaveBeenCalledWith('system_list_skills', { projectDir: '/proj' })
    expect(result).toEqual(skills)
  })

  it('listSkills -> system_list_skills { projectDir: null } when no project is open', async () => {
    invokeMock.mockResolvedValueOnce([])
    await bridge.listSkills(null)
    expect(invokeMock).toHaveBeenCalledWith('system_list_skills', { projectDir: null })
  })

  it('writeSkill -> system_write_skill { provider, name, content, projectDir }, exact args', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, error: null })
    const result = await bridge.writeSkill('claude', 'my-skill', '# Body', '/proj')
    expect(invokeMock).toHaveBeenCalledWith('system_write_skill', {
      provider: 'claude',
      name: 'my-skill',
      content: '# Body',
      projectDir: '/proj'
    })
    expect(result).toEqual({ ok: true, error: null })
  })

  it('writeSkill -> system_write_skill { projectDir: null } when no project is open', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, error: null })
    await bridge.writeSkill('codex', 'deploy', 'body', null)
    expect(invokeMock).toHaveBeenCalledWith('system_write_skill', {
      provider: 'codex',
      name: 'deploy',
      content: 'body',
      projectDir: null
    })
  })

  it('writeSkill -> ok:false shape survives unchanged (invalid name rejection)', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: 'invalid skill name "bad/name" — use only letters, numbers, "_" and "-" (1-64 chars)'
    })
    const result = await bridge.writeSkill('claude', 'bad/name', 'x', null)
    expect(result).toEqual({
      ok: false,
      error: 'invalid skill name "bad/name" — use only letters, numbers, "_" and "-" (1-64 chars)'
    })
  })

  it('deleteSkill -> system_delete_skill { path }, exact args', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, error: null })
    const result = await bridge.deleteSkill('/home/dev/.claude/skills/my-skill/SKILL.md')
    expect(invokeMock).toHaveBeenCalledWith('system_delete_skill', {
      path: '/home/dev/.claude/skills/my-skill/SKILL.md'
    })
    expect(result).toEqual({ ok: true, error: null })
  })

  it('deleteSkill -> ok:false shape survives unchanged (out-of-policy path rejection)', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: 'refusing to delete outside known skill roots: /etc/passwd'
    })
    const result = await bridge.deleteSkill('/etc/passwd')
    expect(result).toEqual({
      ok: false,
      error: 'refusing to delete outside known skill roots: /etc/passwd'
    })
  })

  it('listShells -> detect_available_shells {}, name/path field names survive unchanged', async () => {
    const shells = [{ name: 'bash', path: '/bin/bash' }]
    invokeMock.mockResolvedValueOnce(shells)
    const result = await bridge.listShells()
    expect(invokeMock).toHaveBeenCalledWith('detect_available_shells', {})
    expect(result).toEqual(shells)
  })

  it('getLogsDir -> system_get_log_path {}', async () => {
    invokeMock.mockResolvedValueOnce('/home/dev/.houston-dev/logs')
    const result = await bridge.getLogsDir()
    expect(invokeMock).toHaveBeenCalledWith('system_get_log_path', {})
    expect(result).toBe('/home/dev/.houston-dev/logs')
  })

  it('addAllowedRoot -> fs_add_allowed_root { root }, additive rather than replacing', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.addAllowedRoot('/home/t/.claude/skills/impeccable/SKILL.md')
    expect(invokeMock).toHaveBeenCalledWith('fs_add_allowed_root', {
      root: '/home/t/.claude/skills/impeccable/SKILL.md'
    })
  })

  it('setAllowedRoots -> fs_set_allowed_roots { roots }', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.setAllowedRoots(['/a', '/b'])
    expect(invokeMock).toHaveBeenCalledWith('fs_set_allowed_roots', { roots: ['/a', '/b'] })
  })

  it('showItemInFolder -> shell_show_item_in_folder { fullPath }, ok/error field names survive unchanged', async () => {
    invokeMock.mockResolvedValueOnce({ ok: false, error: 'not a directory: /p/a.ts' })
    const result = await bridge.showItemInFolder('/p/a.ts')
    expect(invokeMock).toHaveBeenCalledWith('shell_show_item_in_folder', { fullPath: '/p/a.ts' })
    expect(result).toEqual({ ok: false, error: 'not a directory: /p/a.ts' })
  })

  it('showItemInFolder -> ok:true shape survives unchanged, error:null included', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, error: null })
    const result = await bridge.showItemInFolder('/p')
    expect(result).toEqual({ ok: true, error: null })
  })

  it('openMediaFile -> shell_open_media_file { fullPath }', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, error: null })
    const result = await bridge.openMediaFile('/p/shot.png')
    expect(invokeMock).toHaveBeenCalledWith('shell_open_media_file', { fullPath: '/p/shot.png' })
    expect(result).toEqual({ ok: true, error: null })
  })

  it('resolveDroppedFile -> fs_copy_dropped_file { name, bytes }, bytes pass through untouched', async () => {
    invokeMock.mockResolvedValueOnce('/home/dev/.houston-dev/dropped-files/abc/report.pdf')
    const file = new File([new Uint8Array([1, 2, 3])], 'report.pdf', { type: 'application/pdf' })
    const result = await bridge.resolveDroppedFile(file)
    expect(invokeMock).toHaveBeenCalledWith('fs_copy_dropped_file', {
      name: 'report.pdf',
      bytes: new Uint8Array([1, 2, 3])
    })
    const call = invokeMock.mock.calls[0][1] as { name: string; bytes: unknown }
    expect(call.bytes).toBeInstanceOf(Uint8Array)
    expect(result).toBe('/home/dev/.houston-dev/dropped-files/abc/report.pdf')
  })
})

describe('bridge — Electron branch: forwards to window.houston unchanged', () => {
  beforeEach(() => setTauriPresent(false))

  it('pickDirectory -> window.houston.pickDirectory()', async () => {
    const houston = stubHouston()
    houston.pickDirectory.mockResolvedValueOnce('/home/dev/project')
    const result = await bridge.pickDirectory()
    expect(houston.pickDirectory).toHaveBeenCalledWith()
    expect(result).toBe('/home/dev/project')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('pickFile -> window.houston.pickFile(defaultPath)', async () => {
    const houston = stubHouston()
    houston.pickFile.mockResolvedValueOnce(null)
    await bridge.pickFile('/home/dev')
    expect(houston.pickFile).toHaveBeenCalledWith('/home/dev')
  })

  it('windowControl -> window.houston.windowControl(action)', async () => {
    const houston = stubHouston()
    await bridge.windowControl('maximize')
    expect(houston.windowControl).toHaveBeenCalledWith('maximize')
  })

  it('isFocused -> window.houston.isFocused()', async () => {
    const houston = stubHouston()
    houston.isFocused.mockResolvedValueOnce(false)
    const result = await bridge.isFocused()
    expect(houston.isFocused).toHaveBeenCalledWith()
    expect(result).toBe(false)
  })

  it('setZoomFactor -> window.houston.setZoomFactor(factor)', async () => {
    const houston = stubHouston()
    await bridge.setZoomFactor(2)
    expect(houston.setZoomFactor).toHaveBeenCalledWith(2)
  })

  it('startDragging -> no-op (no invoke, no window.houston call)', async () => {
    const houston = stubHouston()
    await bridge.startDragging()
    expect(invokeMock).not.toHaveBeenCalled()
    for (const spy of Object.values(houston)) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('setBackgroundColor -> window.houston.setBackgroundColor(hex)', async () => {
    const houston = stubHouston()
    await bridge.setBackgroundColor('#1a2b3c')
    expect(houston.setBackgroundColor).toHaveBeenCalledWith('#1a2b3c')
  })

  it('saveImage -> window.houston.saveImage(bytes, ext), preload order kept', async () => {
    const houston = stubHouston()
    houston.saveImage.mockResolvedValueOnce('/p/shot.png')
    const bytes = new Uint8Array([9, 9])
    const result = await bridge.saveImage(bytes, 'png')
    expect(houston.saveImage).toHaveBeenCalledWith(bytes, 'png')
    expect(result).toBe('/p/shot.png')
  })

  it('saveReview -> window.houston.saveReview(text)', async () => {
    const houston = stubHouston()
    houston.saveReview.mockResolvedValueOnce('/p/review.md')
    await bridge.saveReview('text')
    expect(houston.saveReview).toHaveBeenCalledWith('text')
  })

  it('openExternal -> window.houston.openExternal(url)', async () => {
    const houston = stubHouston()
    await bridge.openExternal('https://example.com')
    expect(houston.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('readDir -> window.houston.readDir(dir)', async () => {
    const houston = stubHouston()
    houston.readDir.mockResolvedValueOnce([])
    await bridge.readDir('/p')
    expect(houston.readDir).toHaveBeenCalledWith('/p')
  })

  it('readFile -> window.houston.readFile(path)', async () => {
    const houston = stubHouston()
    houston.readFile.mockResolvedValueOnce('contents')
    await bridge.readFile('/p/a.ts')
    expect(houston.readFile).toHaveBeenCalledWith('/p/a.ts')
  })

  it('writeFile -> window.houston.writeFile(path, content)', async () => {
    const houston = stubHouston()
    await bridge.writeFile('/p/a.ts', 'new')
    expect(houston.writeFile).toHaveBeenCalledWith('/p/a.ts', 'new')
  })

  it('statFile -> window.houston.statFile(path)', async () => {
    const houston = stubHouston()
    houston.statFile.mockResolvedValueOnce({ mtimeMs: 1 })
    await bridge.statFile('/p/a.ts')
    expect(houston.statFile).toHaveBeenCalledWith('/p/a.ts')
  })

  it('pathKind -> window.houston.pathKind(path)', async () => {
    const houston = stubHouston()
    houston.pathKind.mockResolvedValueOnce('file')
    await bridge.pathKind('/p/a.ts')
    expect(houston.pathKind).toHaveBeenCalledWith('/p/a.ts')
  })

  it('pickerListDirs -> window.houston.pickerListDirs(path)', async () => {
    const houston = stubHouston()
    houston.pickerListDirs.mockResolvedValueOnce(['x'])
    await bridge.pickerListDirs('/p')
    expect(houston.pickerListDirs).toHaveBeenCalledWith('/p')
  })

  it('listSkills -> window.houston.listSkills(projectDir)', async () => {
    const houston = stubHouston()
    houston.listSkills.mockResolvedValueOnce([])
    await bridge.listSkills('/proj')
    expect(houston.listSkills).toHaveBeenCalledWith('/proj')
  })

  it('writeSkill -> window.houston.writeSkill(provider, name, content, projectDir)', async () => {
    const houston = stubHouston()
    houston.writeSkill.mockResolvedValueOnce({ ok: true })
    await bridge.writeSkill('antigravity', 'tool', 'body', '/proj')
    expect(houston.writeSkill).toHaveBeenCalledWith('antigravity', 'tool', 'body', '/proj')
  })

  it('deleteSkill -> window.houston.deleteSkill(path)', async () => {
    const houston = stubHouston()
    houston.deleteSkill.mockResolvedValueOnce({ ok: true })
    await bridge.deleteSkill('/p/SKILL.md')
    expect(houston.deleteSkill).toHaveBeenCalledWith('/p/SKILL.md')
  })

  it('homeDir -> window.houston.homeDir()', async () => {
    const houston = stubHouston()
    houston.homeDir.mockResolvedValueOnce('/home/dev')
    await bridge.homeDir()
    expect(houston.homeDir).toHaveBeenCalledWith()
  })

  it('listShells -> window.houston.listShells()', async () => {
    const houston = stubHouston()
    houston.listShells.mockResolvedValueOnce([])
    await bridge.listShells()
    expect(houston.listShells).toHaveBeenCalledWith()
  })

  it('getLogsDir -> window.houston.getLogsDir()', async () => {
    const houston = stubHouston()
    houston.getLogsDir.mockResolvedValueOnce('/logs')
    await bridge.getLogsDir()
    expect(houston.getLogsDir).toHaveBeenCalledWith()
  })

  it('setAllowedRoots -> window.houston.setAllowedRoots(roots)', async () => {
    const houston = stubHouston()
    await bridge.setAllowedRoots(['/a'])
    expect(houston.setAllowedRoots).toHaveBeenCalledWith(['/a'])
  })

  it('showItemInFolder -> window.houston.openPath(path)', async () => {
    const houston = stubHouston()
    houston.openPath.mockResolvedValueOnce({ ok: true })
    await bridge.showItemInFolder('/p')
    expect(houston.openPath).toHaveBeenCalledWith('/p')
  })

  it('openMediaFile -> window.houston.openPath(path), same fallback as showItemInFolder', async () => {
    const houston = stubHouston()
    houston.openPath.mockResolvedValueOnce({ ok: true })
    await bridge.openMediaFile('/p/shot.png')
    expect(houston.openPath).toHaveBeenCalledWith('/p/shot.png')
  })

  it('resolveDroppedFile -> window.houston.getPathForFile(file), a real path passes through', async () => {
    const houston = stubHouston()
    const file = new File([], 'report.pdf')
    houston.getPathForFile.mockReturnValueOnce('/home/dev/Downloads/report.pdf')
    const result = await bridge.resolveDroppedFile(file)
    expect(houston.getPathForFile).toHaveBeenCalledWith(file)
    expect(result).toBe('/home/dev/Downloads/report.pdf')
  })

  it('resolveDroppedFile -> normalizes an empty-string getPathForFile result to null', async () => {
    const houston = stubHouston()
    const file = new File([], 'pasted.png')
    houston.getPathForFile.mockReturnValueOnce('')
    const result = await bridge.resolveDroppedFile(file)
    expect(result).toBeNull()
  })

  it('readClipboardImagePath -> navigator.clipboard.read(), saved through window.houston.saveImage', async () => {
    const houston = stubHouston()
    houston.saveImage.mockResolvedValueOnce('/home/dev/.houston/pastes/9.png')
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    stubClipboard({
      read: vi.fn().mockResolvedValue([
        { types: ['text/html'], getType: vi.fn() },
        { types: ['image/png'], getType: vi.fn().mockResolvedValue(blob) }
      ])
    })
    const result = await bridge.readClipboardImagePath()
    expect(result).toBe('/home/dev/.houston/pastes/9.png')
    const [bytes, ext] = houston.saveImage.mock.calls[0]
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3])
    expect(ext).toBe('png')
  })

  it('readClipboardImagePath -> null when the clipboard holds no image', async () => {
    stubHouston()
    stubClipboard({ read: vi.fn().mockResolvedValue([{ types: ['text/plain'], getType: vi.fn() }]) })
    expect(await bridge.readClipboardImagePath()).toBeNull()
  })

  it('readClipboardImagePath -> null when clipboard.read rejects', async () => {
    stubHouston()
    stubClipboard({ read: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await bridge.readClipboardImagePath()).toBeNull()
  })

  it('readClipboardText -> navigator.clipboard.readText()', async () => {
    stubHouston()
    stubClipboard({ readText: vi.fn().mockResolvedValue('echo hi') })
    expect(await bridge.readClipboardText()).toBe('echo hi')
  })
})
