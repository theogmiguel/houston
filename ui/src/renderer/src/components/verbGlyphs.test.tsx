// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GLYPH_FOR_VERB } from './verbGlyphs'
import { Icon } from './ui/Icon'
const source = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('verb glyphs', () => {
  it('gives the different actions distinct glyphs within the shared icon metrics', () => {
    expect(new Set(Object.values(GLYPH_FOR_VERB)).size).toBe(Object.keys(GLYPH_FOR_VERB).length)
    for (const glyph of Object.values(GLYPH_FOR_VERB)) {
      const markup = renderToStaticMarkup(<Icon glyph={glyph} role="small" />)
      expect(markup).toContain('viewBox="0 0 24 24"')
      expect(markup).toContain('aria-hidden="true"')
    }
  })
  it('routes settings and pane/file actions through the shared mapping', () => {
    expect(source('./rail/RailSettingsTree.tsx')).toContain('bell: GLYPH_FOR_VERB.notifications')
    for (const verb of ['measure-memory', 'overview', 'reveal-in-file-manager']) expect(source('./SessionPane.tsx')).toContain(`GLYPH_FOR_VERB['${verb}']`)
    for (const verb of ['wrap-lines', 'toggle-file-tree']) expect(source('./git/PrFiles.tsx')).toContain(`GLYPH_FOR_VERB['${verb}']`)
  })
})
