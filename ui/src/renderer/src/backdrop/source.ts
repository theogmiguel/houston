export type BackgroundSource = { kind: 'preset'; id: string } | { kind: 'user' }

export type LoadedSource = { bitmap: ImageBitmap; width: number; height: number }

export const PRESETS = ['graphite', 'paper'] as const
export type PresetId = (typeof PRESETS)[number]

export const USER_IMAGE = 'user'

export function sourceFor(preset: string): BackgroundSource {
  if (preset === USER_IMAGE) return { kind: 'user' }
  return { kind: 'preset', id: PRESETS.includes(preset as PresetId) ? preset : PRESETS[0] }
}

async function bitmapFromUrl(url: string): Promise<ImageBitmap> {
  const blob = await fetch(url).then((r) => r.blob())
  return createImageBitmap(blob)
}

function toBlob(bytes: ArrayBuffer | Uint8Array | number[]): Blob {
  const part: BlobPart =
    bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)
      ? (bytes as ArrayBuffer | ArrayBufferView<ArrayBuffer>)
      : new Uint8Array(bytes)
  return new Blob([part])
}

export async function loadBackgroundSource(src: BackgroundSource): Promise<LoadedSource | null> {
  if (src.kind === 'preset') {
    try {
      const mod = (await import(`../assets/backgrounds/${src.id}.webp`)) as { default?: string }
      const url = mod.default
      if (!url) return null
      const bitmap = await bitmapFromUrl(url)
      return { bitmap, width: bitmap.width, height: bitmap.height }
    } catch {
      return null
    }
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const info = await invoke<unknown>('fs_window_background_info')
    if (!info) return null
    const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>('fs_read_window_background')
    const bitmap = await createImageBitmap(toBlob(bytes))
    return { bitmap, width: bitmap.width, height: bitmap.height }
  } catch {
    return null
  }
}
