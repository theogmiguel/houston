import {
  IconBinary,
  IconFile,
  IconFileCode,
  IconFileCog,
  IconFileImage,
  IconFileJson,
  IconFileLock,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  type IconComponent
} from './icons'
import { Icon } from './Icon'
import type { TextRole } from './Text'

export type FileTreeIconKind =
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'file-git'
  | 'file-lock'
  | 'file-image'
  | 'file-binary'
  | 'file-config'
  | 'file-data'
  | 'file-code'
  | 'file-text'

const GIT_NAMES = new Set(['.gitignore', '.gitmodules', '.gitattributes', '.gitkeep'])
const LOCK_NAMES = new Set(['package-lock.json', 'yarn.lock'])
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff'])
export const BINARY_EXTS = new Set(['wasm', 'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'bin', 'dat'])
const CONFIG_EXTS = new Set(['toml', 'ini', 'env', 'conf', 'cfg', 'editorconfig', 'prettierrc'])
const DATA_EXTS = new Set(['json', 'jsonc', 'json5', 'yaml', 'yml', 'xml', 'csv', 'sql'])
const CODE_EXTS = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'py',
  'pyi',
  'rs',
  'go',
  'java',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'php',
  'rb',
  'swift',
  'kt',
  'scala',
  'zig',
  'lua'
])
const TEXT_EXTS = new Set(['md', 'mdx', 'txt', 'log'])

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function classifyFileTreeEntry(name: string, isDir: boolean, expanded: boolean): FileTreeIconKind {
  if (isDir) return expanded ? 'folder-open' : 'folder'
  if (GIT_NAMES.has(name)) return 'file-git'
  if (name.endsWith('.lock') || LOCK_NAMES.has(name)) return 'file-lock'
  const ext = extOf(name)
  if (IMAGE_EXTS.has(ext)) return 'file-image'
  if (BINARY_EXTS.has(ext)) return 'file-binary'
  if (CONFIG_EXTS.has(ext)) return 'file-config'
  if (DATA_EXTS.has(ext)) return 'file-data'
  if (CODE_EXTS.has(ext)) return 'file-code'
  if (TEXT_EXTS.has(ext)) return 'file-text'
  return 'file'
}

export const FILE_TREE_ICON_COMPONENT: Record<FileTreeIconKind, IconComponent> = {
  folder: IconFolder,
  'folder-open': IconFolderOpen,
  file: IconFile,
  'file-git': IconGitBranch,
  'file-lock': IconFileLock,
  'file-image': IconFileImage,
  'file-binary': IconBinary,
  'file-config': IconFileCog,
  'file-data': IconFileJson,
  'file-code': IconFileCode,
  'file-text': IconFileText
}

export const FILE_TREE_ICON_TONE_CLS: Record<FileTreeIconKind, string> = {
  folder: 'text-warning',
  'folder-open': 'text-warning',
  file: 'text-text-muted',
  'file-lock': 'text-text-muted',
  'file-binary': 'text-text-muted',
  'file-code': 'text-primary',
  'file-text': 'text-success',
  'file-image': 'text-info',
  'file-config': 'text-info',
  'file-data': 'text-warning',
  'file-git': 'text-danger'
}

export function FileTreeIcon({
  kind,
  role = 'ui'
}: {
  kind: FileTreeIconKind
  role?: TextRole
}): React.JSX.Element {
  return <Icon glyph={FILE_TREE_ICON_COMPONENT[kind]} role={role} className={FILE_TREE_ICON_TONE_CLS[kind]} />
}
