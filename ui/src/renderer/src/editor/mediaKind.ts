import { BINARY_EXTS, IMAGE_EXTS } from '../components/fileTreeIcons'

export type MediaKind = 'image' | 'video' | 'audio' | 'unsupported' | 'text' | 'markdown'

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'])

const MARKDOWN_EXTS = new Set(['md', 'markdown'])

const TEXT_DECODABLE_IMAGE_EXTS = new Set(['svg'])
const PREVIEW_IMAGE_EXTS = new Set([...IMAGE_EXTS].filter((ext) => !TEXT_DECODABLE_IMAGE_EXTS.has(ext)))

const AMBIGUOUS_BINARY_EXTS = new Set(['dat', 'bin'])
const CERTAIN_BINARY_EXTS = new Set(
  [...BINARY_EXTS].filter((ext) => !AMBIGUOUS_BINARY_EXTS.has(ext))
)

export function extOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function classifyMediaKind(path: string): MediaKind {
  const ext = extOf(path)
  if (PREVIEW_IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (CERTAIN_BINARY_EXTS.has(ext)) return 'unsupported'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  return 'text'
}

export function isPreviewBlocked(kind: MediaKind): boolean {
  return kind === 'unsupported'
}

export const MEDIA_EXTS: ReadonlySet<string> = new Set([
  ...PREVIEW_IMAGE_EXTS,
  ...VIDEO_EXTS,
  ...AUDIO_EXTS
])

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac'
}

export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extOf(path)] ?? 'application/octet-stream'
}
