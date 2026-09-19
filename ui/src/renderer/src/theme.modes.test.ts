import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHROME_STORAGE_KEY,
  CHROME_THEME_MODES,
  CHROME_THEMES,
  DEFAULT_CHROME_THEME,
  deriveThemeMode,
  STORAGE_KEY,
  THEME_DESCRIPTIONS,
  THEME_MODES,
  THEMES,
  TERMINAL_PALETTES
} from './theme'

describe('THEME_MODES / THEME_DESCRIPTIONS coverage', () => {
  it('THEME_MODES has exactly one entry per THEMES, no extras', () => {
    const keys = Object.keys(THEME_MODES).sort()
    expect(keys).toEqual([...THEMES].sort())
  })

  it('THEME_DESCRIPTIONS has exactly one entry per THEMES, no extras', () => {
    const keys = Object.keys(THEME_DESCRIPTIONS).sort()
    expect(keys).toEqual([...THEMES].sort())
  })

  it('every description is short (fits under a tile name, not a paragraph)', () => {
    for (const t of THEMES) {
      const desc = THEME_DESCRIPTIONS[t]
      expect(desc.length, `${t} description too long: "${desc}"`).toBeLessThanOrEqual(60)
      expect(desc.length, `${t} description empty`).toBeGreaterThan(0)
    }
  })

  it('re-running deriveThemeMode over each committed TERMINAL_PALETTES background reproduces THEME_MODES exactly', () => {
    for (const t of THEMES) {
      const recomputed = deriveThemeMode(TERMINAL_PALETTES[t].background as string)
      expect(recomputed, `${t}: THEME_MODES says ${THEME_MODES[t]} but deriving from its background gives ${recomputed}`).toBe(
        THEME_MODES[t]
      )
    }
  })
})

describe('deriveThemeMode', () => {
  it('classifies pure black as dark and pure white as light', () => {
    expect(deriveThemeMode('#000000')).toBe('dark')
    expect(deriveThemeMode('#FFFFFF')).toBe('light')
  })
})

describe('index.html LEGACY_LIGHT_IDS sync with THEME_MODES', () => {
  it('the hardcoded LEGACY_LIGHT_IDS array matches THEME_MODES\' light entries exactly', () => {
    const htmlPath = join(__dirname, '../index.html')
    const html = readFileSync(htmlPath, 'utf8')
    const match = html.match(/var LEGACY_LIGHT_IDS = (\[[\s\S]*?\])/)
    expect(match, `LEGACY_LIGHT_IDS array not found in ${htmlPath}`).not.toBeNull()
    const htmlLightIds: string[] = JSON.parse(
      (match as RegExpMatchArray)[1].replace(/'/g, '"').replace(/,\s*\]/, ']')
    )

    const expectedLightIds = THEMES.filter((t) => THEME_MODES[t] === 'light').sort()

    expect(
      [...htmlLightIds].sort(),
      `index.html's LEGACY_LIGHT_IDS ${JSON.stringify([...htmlLightIds].sort())} diverges from ` +
        `THEME_MODES' light entries ${JSON.stringify(expectedLightIds)} -- update index.html's ` +
        'LEGACY_LIGHT_IDS array to match'
    ).toEqual(expectedLightIds)
  })
})

describe('CHROME_THEME_MODES coverage (step 01 guard precondition)', () => {
  it('CHROME_THEME_MODES has exactly one entry per CHROME_THEMES, no extras', () => {
    const keys = Object.keys(CHROME_THEME_MODES).sort()
    expect(keys).toEqual([...CHROME_THEMES].sort())
  })

  it('exactly one chrome theme is light -- the guard treats only "paper" as light', () => {
    const lightChromeThemes = CHROME_THEMES.filter((t) => CHROME_THEME_MODES[t] === 'light')
    expect(lightChromeThemes).toEqual(['paper'])
  })
})

describe('index.html CSP script hash sync with inline theme guard', () => {
  it("the declared 'sha256-…' CSP hash matches the inline <script>'s actual bytes", () => {
    const htmlPath = join(__dirname, '../index.html')
    const html = readFileSync(htmlPath, 'utf8')
    const htmlWithoutComments = html.replace(/<!--[\s\S]*?-->/g, '')

    const scriptMatch = htmlWithoutComments.match(/<script>([\s\S]*?)<\/script>/)
    expect(scriptMatch, `no inline <script>...</script> block found in ${htmlPath}`).not.toBeNull()
    const scriptContent = (scriptMatch as RegExpMatchArray)[1]

    const cspMatch = html.match(/script-src[^;]*'sha256-([^']+)'/)
    expect(
      cspMatch,
      `no 'sha256-…' hash found in the CSP meta's script-src directive in ${htmlPath}`
    ).not.toBeNull()
    const declaredHash = (cspMatch as RegExpMatchArray)[1]

    const computedHash = createHash('sha256').update(scriptContent, 'utf8').digest('base64')

    expect(
      declaredHash,
      `index.html's CSP declares script-src hash 'sha256-${declaredHash}' but the inline ` +
        `<script>'s actual content hashes to 'sha256-${computedHash}' -- a mismatch means the ` +
        "CSP blocks the pre-paint theme guard from executing at all (silently: it's a CSP " +
        "violation, never reaches the guard's own try/catch). Recompute and update the declared " +
        'hash to match the current script content.'
    ).toBe(computedHash)
  })
})

describe('index.html storage keys sync with theme.ts CHROME_STORAGE_KEY / STORAGE_KEY', () => {
  it("the two localStorage.getItem(...) literals match theme.ts's CHROME_STORAGE_KEY then STORAGE_KEY, in order", () => {
    const htmlPath = join(__dirname, '../index.html')
    const html = readFileSync(htmlPath, 'utf8')
    const htmlWithoutComments = html.replace(/<!--[\s\S]*?-->/g, '')

    const keyMatches = [
      ...htmlWithoutComments.matchAll(/localStorage\.getItem\(\s*['"]([^'"]+)['"]\s*\)/g)
    ].map((m) => m[1])
    expect(
      keyMatches.length,
      `expected 2 localStorage.getItem('...') calls in ${htmlPath} (chrome key, then the legacy ` +
        `fallback), found ${keyMatches.length}: ${JSON.stringify(keyMatches)} -- the pre-paint ` +
        'guard may have been removed or rewritten, so there is nothing left to pin against ' +
        "theme.ts's CHROME_STORAGE_KEY/STORAGE_KEY"
    ).toBe(2)

    expect(
      keyMatches[0],
      `index.html's pre-paint guard reads chrome-theme key '${keyMatches[0]}' but theme.ts's ` +
        `CHROME_STORAGE_KEY is '${CHROME_STORAGE_KEY}' -- a mismatch means the guard reads a key ` +
        'nothing writes and always falls through to the legacy-migration guess. Update ' +
        'index.html to match CHROME_STORAGE_KEY.'
    ).toBe(CHROME_STORAGE_KEY)

    expect(
      keyMatches[1],
      `index.html's pre-paint guard reads legacy terminal-palette key '${keyMatches[1]}' but ` +
        `theme.ts's STORAGE_KEY is '${STORAGE_KEY}' -- a mismatch means a pre-step-01 install's ` +
        'first post-upgrade boot always takes the dark path and the flash this guard exists to ' +
        'prevent returns silently for anyone migrating onto Paper. Update index.html to match ' +
        'STORAGE_KEY.'
    ).toBe(STORAGE_KEY)
  })
})


describe('retired chrome themes', () => {
  it('keeps warm-espresso on the TERMINAL axis, which is a separate selection', () => {
    expect(THEMES).toContain('warm-espresso')
    expect(CHROME_THEMES).not.toContain('warm-espresso' as never)
  })

  it('paints a dark ladder on a fresh install', () => {
    expect(CHROME_THEME_MODES[DEFAULT_CHROME_THEME]).toBe('dark')
  })
})
