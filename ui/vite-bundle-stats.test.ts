import { describe, expect, it } from 'vitest'
import { appModulePathFromModuleId, packageNameFromModuleId } from './vite-bundle-stats'

describe('packageNameFromModuleId', () => {
  it('names scoped and unscoped packages, and nothing outside node_modules', () => {
    expect(packageNameFromModuleId('/w/ui/node_modules/react/index.js')).toBe('react')
    expect(
      packageNameFromModuleId('/w/ui/node_modules/@codemirror/lang-javascript/dist/index.js')
    ).toBe('@codemirror/lang-javascript')
    expect(
      packageNameFromModuleId('/w/node_modules/a/node_modules/@scope/b/index.js')
    ).toBe('@scope/b')
    expect(packageNameFromModuleId('/w/ui/src/renderer/src/main.tsx')).toBe(null)
  })
})

describe('appModulePathFromModuleId', () => {
  const CWD = '/w/ui'

  it('returns app-source paths relative to the build cwd', () => {
    expect(appModulePathFromModuleId('/w/ui/src/renderer/src/ghostty/core.ts', CWD)).toBe(
      'src/renderer/src/ghostty/core.ts'
    )
  })

  it('strips a query suffix so one rule covers a module however it was imported', () => {
    expect(
      appModulePathFromModuleId('/w/ui/src/renderer/src/ghostty/vendor/ghostty-vt.wasm?url', CWD)
    ).toBe('src/renderer/src/ghostty/vendor/ghostty-vt.wasm')
  })

  it('declines npm packages — those are `packages`’ job, not a path rule’s', () => {
    expect(appModulePathFromModuleId('/w/ui/node_modules/react/index.js', CWD)).toBe(null)
  })

  it('declines virtual and non-file ids, which no path rule could name', () => {
    expect(appModulePathFromModuleId('\0vite/preload-helper.js', CWD)).toBe(null)
    expect(appModulePathFromModuleId('\0commonjsHelpers.js', CWD)).toBe(null)
    expect(appModulePathFromModuleId('virtual:tr-thing', CWD)).toBe(null)
    expect(appModulePathFromModuleId('', CWD)).toBe(null)
  })

  it('keeps a module outside the build cwd, with its ../ prefix', () => {
    expect(appModulePathFromModuleId('/w/protocol/types.ts', CWD)).toBe('../protocol/types.ts')
  })
})
