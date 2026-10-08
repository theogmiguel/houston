import { describe, expect, it } from 'vitest'
import { IconDatabase, IconFile, IconFileArchive, IconFileBox, IconFileCode, IconFileCog, IconFileImage, IconFileJson, IconFileLock, IconFileSliders, IconFileText } from '../icons'
import { fileTypeIcon } from './fileTypeIcons'

describe('fileTypeIcon', () => {
  it('picks a glyph by extension, case-insensitively', () => {
    expect(fileTypeIcon('db/schema.rb')).toBe(IconFileCode)
    expect(fileTypeIcon('src/App.TSX')).toBe(IconFileCode)
    expect(fileTypeIcon('fixtures/data.json')).toBe(IconFileJson)
    expect(fileTypeIcon('docs/README.md')).toBe(IconFileText)
    expect(fileTypeIcon('logo.png')).toBe(IconFileImage)
    expect(fileTypeIcon('dump.sqlite')).toBe(IconDatabase)
  })

  it('prefers exact file names and the dotfile rules over the extension', () => {
    expect(fileTypeIcon('.editorconfig')).toBe(IconFileSliders)
    expect(fileTypeIcon('.env.production')).toBe(IconFileLock)
    expect(fileTypeIcon('docker/Dockerfile.dev')).toBe(IconFileCog)
    expect(fileTypeIcon('package.json')).toBe(IconFileBox)
    expect(fileTypeIcon('Gemfile.lock')).toBe(IconFileLock)
    expect(fileTypeIcon('README.md')).toBe(IconFileText)
  })

  it('matches the longest multi-part extension first', () => {
    expect(fileTypeIcon('release.tar.gz')).toBe(IconFileArchive)
    expect(fileTypeIcon('app.config.ts')).toBe(IconFileCode)
  })

  it('falls back to the plain file glyph', () => {
    expect(fileTypeIcon('notes.zzz')).toBe(IconFile)
    expect(fileTypeIcon('LICENSE.')).toBe(IconFile)
    expect(fileTypeIcon('')).toBe(IconFile)
  })
})
