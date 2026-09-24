import { isSensitivePath } from '../git/review'

export const WORKSPACE_REFUSAL_RULE =
  'the disk root and secret directories cannot be workspaces.'

const CREDENTIAL_DIRS = ['.ssh', '.gnupg', '.aws']

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

export function workspaceRefusal(path: string): string | null {
  const p = normalizeWorkspacePath(path)

  if (p === '/') return refusal(path)

  const segments = p.split('/').filter((s) => s !== '')
  if (segments.some((s) => CREDENTIAL_DIRS.includes(s.toLowerCase()))) return refusal(path)

  if (isSensitivePath(p)) return refusal(path)

  return null
}

function refusal(path: string): string {
  return `${path} can't be a workspace — ${WORKSPACE_REFUSAL_RULE}`
}
