import type { MascotPrefs } from './mascotPrefs'

export const MASCOT_FILTERS: Record<MascotPrefs['colors'], string> = {
  classic: 'none',
  aurora: 'hue-rotate(-70deg) saturate(1.1)',
  sunset: 'hue-rotate(140deg) saturate(1.15)',
  mono: 'grayscale(1) brightness(1.15)'
}

// Canvas filter is unavailable in some desktop webviews; bake the CSS colour matrices into the game sprite.
export function recolorMascotPixels(pixels: Uint8ClampedArray, colors: MascotPrefs['colors']): void {
  if (colors === 'classic') return
  const angle = (colors === 'sunset' ? 140 : -70) * Math.PI / 180
  const c = Math.cos(angle), s = Math.sin(angle), saturation = colors === 'sunset' ? 1.15 : 1.1
  const clamp = (v: number): number => Math.max(0, Math.min(255, v))
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
    if (colors === 'mono') {
      pixels[i] = pixels[i + 1] = pixels[i + 2] = (.2126 * r + .7152 * g + .0722 * b) * 1.15
      continue
    }
    const red = clamp((.213 + .787 * c - .213 * s) * r + (.715 - .715 * c - .715 * s) * g + (.072 - .072 * c + .928 * s) * b)
    const green = clamp((.213 - .213 * c + .143 * s) * r + (.715 + .285 * c + .140 * s) * g + (.072 - .072 * c - .283 * s) * b)
    const blue = clamp((.213 - .213 * c - .787 * s) * r + (.715 - .715 * c + .715 * s) * g + (.072 + .928 * c + .072 * s) * b)
    const luminance = .213 * red + .715 * green + .072 * blue
    pixels[i] = luminance + saturation * (red - luminance)
    pixels[i + 1] = luminance + saturation * (green - luminance)
    pixels[i + 2] = luminance + saturation * (blue - luminance)
  }
}
