import type { GitFileStatus } from '../../houston/client'

// Keep references below the terminal paste bound and reject ambiguous traversal.
export const FILE_REFERENCE_MAX = 4096
export const FILE_REFERENCE_MIME = 'application/x-houston-file'

export function fileReference(path: string, directory: boolean): string {
  if (!path || path.length > FILE_REFERENCE_MAX || path.split(/[\\/]/).includes('..') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Cannot insert ${JSON.stringify(path)}: expected a path without '..' or control characters, at most ${FILE_REFERENCE_MAX} characters`)
  }
  const value = directory ? `${path.replace(/\/+$/, '')}/` : path
  if (value.length > FILE_REFERENCE_MAX) throw new Error(`Cannot insert ${JSON.stringify(value)}: expected at most ${FILE_REFERENCE_MAX} path characters`)
  return `@${/[\s"'\\]/.test(value) ? JSON.stringify(value) : value} `
}

const SEVERITY = { conflicted: 5, deleted: 4, modified: 3, renamed: 3, added: 2, untracked: 1 }
export function gitTreeStatus(root: string, path: string, directory: boolean, files: readonly GitFileStatus[]): GitFileStatus['status'] | null {
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  const matching = files.filter((file) => file.path === relative || (directory && file.path.startsWith(`${relative}/`)))
  return matching.reduce<GitFileStatus['status'] | null>((status, file) => !status || SEVERITY[file.status] > SEVERITY[status] ? file.status : status, null)
}
