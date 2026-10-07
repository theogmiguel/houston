export interface FileIconDetails {
  label: string
  color: string
}

const EXTENSION_ICONS: Record<string, FileIconDetails> = {
  ts: { label: 'TS', color: 'var(--info)' },
  tsx: { label: 'TS', color: 'var(--info)' },
  js: { label: 'JS', color: 'var(--warn)' },
  jsx: { label: 'JS', color: 'var(--warn)' },
  mjs: { label: 'JS', color: 'var(--warn)' },
  cjs: { label: 'JS', color: 'var(--warn)' },
  rs: { label: 'RS', color: 'var(--warn)' },
  rb: { label: 'RB', color: 'var(--stop)' },
  py: { label: 'PY', color: 'var(--info)' },
  go: { label: 'GO', color: 'var(--info)' },
  java: { label: 'JV', color: 'var(--warn)' },
  c: { label: 'C', color: 'var(--info)' },
  h: { label: 'H', color: 'var(--info)' },
  cc: { label: 'C++', color: 'var(--info)' },
  cpp: { label: 'C++', color: 'var(--info)' },
  hpp: { label: 'H++', color: 'var(--info)' },
  md: { label: 'MD', color: 'var(--text-muted)' },
  mdx: { label: 'MD', color: 'var(--text-muted)' },
  json: { label: '{}', color: 'var(--warn)' },
  jsonc: { label: '{}', color: 'var(--warn)' },
  toml: { label: 'TM', color: 'var(--text-muted)' },
  yml: { label: 'YM', color: 'var(--stop)' },
  yaml: { label: 'YM', color: 'var(--stop)' },
  csv: { label: 'CSV', color: 'var(--ok)' },
  tsv: { label: 'TSV', color: 'var(--ok)' },
  html: { label: 'HT', color: 'var(--warn)' },
  htm: { label: 'HT', color: 'var(--warn)' },
  css: { label: 'CSS', color: 'var(--accent)' },
  scss: { label: 'CSS', color: 'var(--accent)' },
  sass: { label: 'CSS', color: 'var(--accent)' },
  less: { label: 'CSS', color: 'var(--accent)' },
  sql: { label: 'SQL', color: 'var(--info)' },
  sh: { label: 'SH', color: 'var(--ok)' },
  bash: { label: 'SH', color: 'var(--ok)' },
  zsh: { label: 'SH', color: 'var(--ok)' },
  xml: { label: 'XML', color: 'var(--warn)' },
  lock: { label: 'LK', color: 'var(--text-muted)' },
  log: { label: 'LOG', color: 'var(--text-muted)' },
}

const DOTFILE_ICONS: Record<string, FileIconDetails> = {
  '.dockerignore': { label: 'DK', color: 'var(--info)' },
  '.editorconfig': { label: 'EC', color: 'var(--text-muted)' },
  '.env': { label: 'ENV', color: 'var(--warn)' },
  '.gitignore': { label: 'GI', color: 'var(--text-muted)' },
}

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

export function fileIconForPath(path: string): FileIconDetails {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const dotfile = DOTFILE_ICONS[name]
  if (dotfile) return dotfile
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  return EXTENSION_ICONS[extension] ?? { label: '··', color: 'var(--text-muted)' }
}
