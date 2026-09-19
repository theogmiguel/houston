export interface SkillUrlPreview {
  name: string
  description: string
  content: string
  sizeBytes: number
}

export interface SkillUrlConflict {
  existingContent: string
  path: string
}

export type InstallSkillUrlResult =
  | { ok: true; error: null; conflict: null }
  | { ok: false; error: string; conflict: SkillUrlConflict | null }

async function invoker(): Promise<
  <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

export async function previewSkillUrl(url: string): Promise<SkillUrlPreview> {
  const invoke = await invoker()
  return invoke<SkillUrlPreview>('system_preview_skill_url', { url })
}

export async function installSkillFromUrl(
  name: string,
  content: string,
  projectDir: string | null,
  overwrite: boolean
): Promise<InstallSkillUrlResult> {
  const invoke = await invoker()
  return invoke<InstallSkillUrlResult>('system_install_skill_url', {
    name,
    content,
    projectDir,
    overwrite
  })
}
