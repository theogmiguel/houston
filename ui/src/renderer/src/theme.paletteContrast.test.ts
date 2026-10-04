import { describe, expect, it } from 'vitest'
import { TERMINAL_PALETTES, THEMES } from './theme'

const ANSI_CHROMATIC_COLORS = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
  'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan'
] as const

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => parseInt(channel, 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

describe('terminal palette contrast', () => {
  it('keeps foreground and chromatic ANSI colors at least 3:1 against each palette background', () => {
    for (const theme of THEMES) {
      const palette = TERMINAL_PALETTES[theme]
      for (const color of ['foreground', ...ANSI_CHROMATIC_COLORS] as const) {
        expect(
          contrastRatio(palette[color]!, palette.background!),
          `${theme}.${color} against ${palette.background}`
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
