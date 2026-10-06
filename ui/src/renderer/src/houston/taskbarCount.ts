import { isTauri } from './host'

function overlayIcon(count: number): Uint8Array {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is unavailable')
  context.clearRect(0, 0, 16, 16)
  context.beginPath()
  context.arc(8, 8, 8, 0, Math.PI * 2)
  context.fillStyle = '#c83e4d'
  context.fill()
  context.fillStyle = '#ffffff'
  context.font = 'bold 11px sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(count > 9 ? '9+' : String(count), 8, 8)
  const png = canvas.toDataURL('image/png').split(',')[1]
  const binary = atob(png)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export async function setTaskbarAttentionCount(count: number): Promise<void> {
  if (!isTauri()) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const current = getCurrentWindow()
  const platform = navigator.userAgent
  if (/Windows/i.test(platform)) {
    await current.setOverlayIcon(count > 0 ? overlayIcon(count) : undefined)
  } else if (/Linux|Macintosh|Mac OS/i.test(platform)) {
    await current.setBadgeCount(count > 0 ? count : undefined)
  }
}
