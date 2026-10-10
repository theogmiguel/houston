import { wslWorkspaceOf } from './environments'
import { parseWslPath, wslUncPath } from './wslPath'

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

// Argument names that hold a filesystem path in the bridge's commands.
const PATH_ARGS = new Set([
  'dirPath', 'filePath', 'targetPath', 'path', 'root', 'roots', 'dirs',
  'fromPath', 'toPath', 'fullPath', 'projectDir', 'defaultPath'
])
// Commands whose results hold absolute paths; file contents are never rewritten.
const PATH_RESULTS = new Set(['fs_read_directory', 'fs_picker_list_dirs'])

/** A POSIX path inside a WSL workspace becomes its `\\wsl.localhost\<distro>` path. */
export function toWindowsPath(path: string): string {
  const owner = path.startsWith('/') ? wslWorkspaceOf(path) : null
  return owner === null ? path : wslUncPath(owner.distro, path)
}

export function fromWindowsPaths<T>(value: T): T {
  if (typeof value === 'string') return (parseWslPath(value)?.path ?? value) as T
  if (Array.isArray(value)) return value.map(fromWindowsPaths) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromWindowsPaths(v)])) as T
  }
  return value
}

function toWindowsArg(value: unknown): unknown {
  if (typeof value === 'string') return toWindowsPath(value)
  if (Array.isArray(value)) return value.map(toWindowsArg)
  return value
}

export function wslInvoke(invoke: Invoke): Invoke {
  return async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const mapped = args && Object.fromEntries(Object.entries(args).map(([k, v]) => [k, PATH_ARGS.has(k) ? toWindowsArg(v) : v]))
    const result = await invoke<T>(cmd, mapped)
    return PATH_RESULTS.has(cmd) ? fromWindowsPaths(result) : result
  }
}
