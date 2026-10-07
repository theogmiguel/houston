import { describe, expect, it } from 'vitest'
import { fileIconForPath, IMAGE_EXTENSIONS } from './fileIconMap'

describe('file icon mapping', () => {
  it('matches the Files mock labels for its representative extensions', () => {
    expect(fileIconForPath('src/App.tsx').label).toBe('TS')
    expect(fileIconForPath('core/lib.rs').label).toBe('RS')
    expect(fileIconForPath('docs/readme.md').label).toBe('MD')
    expect(fileIconForPath('config.json').label).toBe('{}')
    expect(fileIconForPath('Cargo.toml').label).toBe('TM')
    expect(fileIconForPath('.github/workflows/ci.yml').label).toBe('YM')
    expect(fileIconForPath('data.csv').label).toBe('CSV')
  })

  it('maps common source and config extensions rather than using the generic chip', () => {
    for (const path of ['app.rb', 'main.py', 'server.go', 'index.js', 'styles.css', '.gitignore', '.env']) {
      expect(fileIconForPath(path).label, path).not.toBe('··')
    }
  })

  it('keeps image extensions on the image preview glyph path', () => {
    expect([...IMAGE_EXTENSIONS]).toEqual(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
  })

  it('uses the generic chip only when the extension has no mapping', () => {
    expect(fileIconForPath('assets/unknown.zzz')).toEqual({ label: '··', color: 'var(--text-muted)' })
  })
})
