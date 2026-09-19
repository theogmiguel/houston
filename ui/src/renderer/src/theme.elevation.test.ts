import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHROME_THEMES, DEFAULT_TERMINAL_PALETTE_FOR_CHROME, TERMINAL_PALETTES } from './theme'

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const expand = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(expand.slice(0, 2), 16)
  const g = parseInt(expand.slice(2, 4), 16)
  const b = parseInt(expand.slice(4, 6), 16)
  const linear = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function readThemeCssToken(css: string, theme: string, token: string): string {
  const blockRe = new RegExp(`\\[data-theme=['"]${theme}['"]\\]\\s*\\{([\\s\\S]*?)\\n\\}`)
  const block = css.match(blockRe)
  expect(block, `no [data-theme='${theme}'] block found in theme.css`).not.toBeNull()
  const tokenRe = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{3,6})`)
  const m = (block as RegExpMatchArray)[1].match(tokenRe)
  expect(m, `no ${token} hex declaration found in theme.css's [data-theme='${theme}'] block`).not.toBeNull()
  return (m as RegExpMatchArray)[1]
}

describe('chrome/canvas elevation ladder (theme.css tokens vs TERMINAL_PALETTES defaults)', () => {
  const cssPath = join(__dirname, 'theme.css')
  const css = readFileSync(cssPath, 'utf8')

  for (const chrome of CHROME_THEMES) {
    it(`${chrome}: rail-bg > content-bg > tool-code-bg (measured "rail > content > tool-code" ladder) in luminance`, () => {
      const railBg = readThemeCssToken(css, chrome, '--rail-bg')
      const contentBg = readThemeCssToken(css, chrome, '--content-bg')
      const toolCodeBg = readThemeCssToken(css, chrome, '--tool-code-bg')

      const railL = relativeLuminance(railBg)
      const contentL = relativeLuminance(contentBg)
      const toolCodeL = relativeLuminance(toolCodeBg)

      expect(railL, `${chrome}: --rail-bg (${railBg}) should be lighter than --content-bg (${contentBg})`).toBeGreaterThan(
        contentL
      )
      expect(
        contentL,
        `${chrome}: --content-bg (${contentBg}) should be lighter than --tool-code-bg (${toolCodeBg})`
      ).toBeGreaterThan(toolCodeL)
    })

    it(`${chrome}: --tool-code-bg exactly equals its default terminal palette's background (seam discipline)`, () => {
      const toolCodeBg = readThemeCssToken(css, chrome, '--tool-code-bg')
      const defaultPalette = DEFAULT_TERMINAL_PALETTE_FOR_CHROME[chrome]
      const paletteBg = TERMINAL_PALETTES[defaultPalette].background as string

      expect(toolCodeBg.toLowerCase()).toBe(paletteBg.toLowerCase())
    })
  }
})
