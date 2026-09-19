import { isTauri } from './host'
import type { DirEntry, Skill } from '../env'

async function invoker(): Promise<
  <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

export async function pickDirectory(): Promise<string | null> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string | null>('dialog_pick_directory', {})
  }
  return window.houston.pickDirectory()
}

export async function pickDirectories(): Promise<string[] | null> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string[] | null>('dialog_pick_directories', {})
  }
  const one = await window.houston.pickDirectory()
  return one === null ? null : [one]
}

export async function pickFile(defaultPath: string): Promise<string | null> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string | null>('dialog_pick_file', { defaultPath })
  }
  return window.houston.pickFile(defaultPath)
}

type WindowControlAction = 'close' | 'minimize' | 'maximize' | 'focus'

const WINDOW_CONTROL_COMMANDS: Record<WindowControlAction, string> = {
  close: 'window_close',
  minimize: 'window_minimize',
  maximize: 'window_maximize',
  focus: 'window_focus'
}

export async function windowButtonLayout(): Promise<string | null> {
  if (!isTauri()) return null
  const invoke = await invoker()
  try {
    return (await invoke<string | null>('window_button_layout', {})) ?? null
  } catch {
    return null
  }
}

export async function windowControl(action: WindowControlAction): Promise<void> {
  if (isTauri()) {
    const invoke = await invoker()
    await invoke<void>(WINDOW_CONTROL_COMMANDS[action], {})
    return
  }
  window.houston.windowControl(action)
}

export async function isFocused(): Promise<boolean> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<boolean>('window_is_focused', {})
  }
  return window.houston.isFocused()
}

export async function windowIsMaximized(): Promise<boolean> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<boolean>('window_is_maximized', {})
  }
  return false
}

export async function setZoomFactor(factor: number): Promise<void> {
  if (isTauri()) {
    const invoke = await invoker()
    await invoke<void>('window_set_zoom', { factor })
    return
  }
  window.houston.setZoomFactor(factor)
}

export async function setBackgroundColor(hex: string): Promise<void> {
  if (isTauri()) {
    const invoke = await invoker()
    await invoke<void>('window_set_background_color', { hex })
    return
  }
  window.houston.setBackgroundColor(hex)
}

export async function saveImage(bytes: Uint8Array, ext: string): Promise<string> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string>('fs_save_image', { ext, bytes })
  }
  return window.houston.saveImage(bytes, ext)
}

export async function readClipboardImagePath(): Promise<string | null> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string | null>('clipboard_save_image', {})
  }
  let items: ClipboardItem[]
  try {
    items = await navigator.clipboard.read()
  } catch {
    return null
  }
  for (const item of items) {
    const mime = item.types.find((t) => t.startsWith('image/'))
    if (!mime) continue
    const blob = await item.getType(mime)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return saveImage(bytes, mime.split('/')[1] || 'png')
  }
  return null
}

export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string>('clipboard_read_text', {})
  }
  return navigator.clipboard.readText()
}

export async function saveReview(text: string): Promise<string> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string>('fs_save_review', { text })
  }
  return window.houston.saveReview(text)
}

export async function resolveDroppedFile(file: File): Promise<string | null> {
  if (isTauri()) {
    const invoke = await invoker()
    const bytes = new Uint8Array(await file.arrayBuffer())
    return invoke<string>('fs_copy_dropped_file', { name: file.name, bytes })
  }
  const path = window.houston.getPathForFile(file)
  return path || null
}

export async function saveImageFromUrl(url: string): Promise<string | null> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string | null>('dialog_save_image_url', { url })
  }
  throw new Error('saving an image needs the desktop app — use Open instead')
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const invoke = await invoker()
    await invoke<void>('shell_open_external', { url })
    return
  }
  window.houston.openExternal(url)
}

export async function readDir(dir: string): Promise<DirEntry[]> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<DirEntry[]>('fs_read_directory', { dirPath: dir })
  }
  return window.houston.readDir(dir)
}

export async function readFile(path: string): Promise<string> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string>('fs_read_file', { filePath: path })
  }
  return window.houston.readFile(path)
}

export async function readMediaFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const invoke = await invoker()
  const buf = await invoke<ArrayBuffer>('fs_read_media', { filePath: path })
  return new Uint8Array(buf)
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<void>('fs_write_file', { filePath: path, content })
  }
  return window.houston.writeFile(path, content)
}

export async function statFile(path: string): Promise<{ mtimeMs: number } | null> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<{ mtimeMs: number } | null>('fs_stat', { targetPath: path })
  }
  return window.houston.statFile(path)
}

export async function pathKind(path: string): Promise<'file' | 'dir' | null> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<'file' | 'dir' | null>('fs_exists', { targetPath: path })
  }
  return window.houston.pathKind(path)
}

export async function pickerListDirs(path: string): Promise<string[] | null> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string[] | null>('fs_picker_list_dirs', { path })
  }
  return window.houston.pickerListDirs(path)
}

export async function listSkills(projectDir: string | null): Promise<Skill[]> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<Skill[]>('system_list_skills', { projectDir })
  }
  return window.houston.listSkills(projectDir)
}

type WriteSkillResult = { ok: true; error?: string | null } | { ok: false; error: string }

export async function writeSkill(
  provider: 'claude' | 'codex' | 'antigravity',
  name: string,
  content: string,
  projectDir: string | null
): Promise<WriteSkillResult> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<WriteSkillResult>('system_write_skill', { provider, name, content, projectDir })
  }
  return window.houston.writeSkill(provider, name, content, projectDir)
}

export async function deleteSkill(path: string): Promise<WriteSkillResult> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<WriteSkillResult>('system_delete_skill', { path })
  }
  return window.houston.deleteSkill(path)
}

export async function homeDir(): Promise<string> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string>('system_get_home_dir', {})
  }
  return window.houston.homeDir()
}

export async function listShells(): Promise<Array<{ name: string; path: string }>> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<Array<{ name: string; path: string }>>('detect_available_shells', {})
  }
  return window.houston.listShells()
}

export async function getLogsDir(): Promise<string> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string>('system_get_log_path', {})
  }
  return window.houston.getLogsDir()
}

export async function thirdPartyLicenses(): Promise<string> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<string>('system_third_party_licenses', {})
  }
  throw new Error(
    'the third-party licence inventory (system_third_party_licenses) is only available in the desktop app'
  )
}

export async function addAllowedRoot(path: string): Promise<void> {
  const invoke = await invoker()
  await invoke<void>('fs_add_allowed_root', { root: path })
}

export async function setAllowedRoots(roots: string[]): Promise<void> {
  if (isTauri()) {
    const invoke = await invoker()
    await invoke<void>('fs_set_allowed_roots', { roots })
    return
  }
  window.houston.setAllowedRoots(roots)
}

type PathOpenResult = { ok: true; error?: string | null } | { ok: false; error: string }

export interface EditorTarget {
  id: string
  label: string
}

export async function listEditors(): Promise<EditorTarget[]> {
  if (!isTauri()) return []
  try {
    const invoke = await invoker()
    return await invoke<EditorTarget[]>('shell_list_editors')
  } catch {
    return []
  }
}

export async function openInEditor(
  editor: string,
  path: string,
  line?: number,
  col?: number
): Promise<void> {
  const invoke = await invoker()
  return invoke<void>('shell_open_in_editor', { editor, path, line, col })
}

export async function showItemInFolder(path: string): Promise<PathOpenResult> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<PathOpenResult>('shell_show_item_in_folder', { fullPath: path })
  }
  return window.houston.openPath(path)
}

export async function bindAgentSessionLocation(
  sessionId: number,
  workspaceId: string | null,
  paneId: string | null
): Promise<void> {
  const invoke = await invoker()
  await invoke<unknown>('agent_session_bind_location', { sessionId, workspaceId, paneId })
}

export async function startDragging(): Promise<void> {
  if (isTauri()) {
    const invoke = await invoker()
    await invoke<void>('window_start_dragging', {})
    return
  }
}

export type ResizeDirection =
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'north-east'
  | 'north-west'
  | 'south-east'
  | 'south-west'

export async function startResizeDragging(direction: ResizeDirection): Promise<void> {
  if (!isTauri()) return
  const invoke = await invoker()
  await invoke<void>('window_start_resize_dragging', { direction })
}

export async function openMediaFile(path: string): Promise<PathOpenResult> {
  if (isTauri()) {
    const invoke = await invoker()
    return invoke<PathOpenResult>('shell_open_media_file', { fullPath: path })
  }
  return window.houston.openPath(path)
}

export async function deleteAgentSession(
  sessionId: number,
  nativeSessionId: string | null
): Promise<void> {
  const invoke = await invoker()
  await invoke<{ sessionId: number; nativeSessionId: string | null }>('agent_session_delete', {
    sessionId,
    nativeSessionId
  })
}

export async function dismissAgentSession(
  sessionId: number,
  nativeSessionId: string | null
): Promise<void> {
  const invoke = await invoker()
  await invoke<{ sessionId: number; nativeSessionId: string | null }>('agent_session_dismiss', {
    sessionId,
    nativeSessionId
  })
}
