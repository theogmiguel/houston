import { describe, expect, it } from 'vitest'
import {
  classifyFileTreeEntry,
  FILE_TREE_ICON_COMPONENT,
  FILE_TREE_ICON_TONE_CLS
} from './fileTreeIcons'
import { IconFileCog, IconFileJson } from './icons'

describe('classifyFileTreeEntry', () => {
  it('directories: closed -> folder, expanded -> folder-open', () => {
    expect(classifyFileTreeEntry('src', true, false)).toBe('folder')
    expect(classifyFileTreeEntry('src', true, true)).toBe('folder-open')
  })

  it('.gitignore -> file-git, not file-config or file-text', () => {
    expect(classifyFileTreeEntry('.gitignore', false, false)).toBe('file-git')
  })

  it('x.lock -> file-lock', () => {
    expect(classifyFileTreeEntry('x.lock', false, false)).toBe('file-lock')
  })

  it('package-lock.json -> file-lock, not file-data', () => {
    expect(classifyFileTreeEntry('package-lock.json', false, false)).toBe('file-lock')
  })

  it('x.png -> file-image', () => {
    expect(classifyFileTreeEntry('x.png', false, false)).toBe('file-image')
  })

  it('x.wasm -> file-binary', () => {
    expect(classifyFileTreeEntry('x.wasm', false, false)).toBe('file-binary')
  })

  it('x.toml -> file-config', () => {
    expect(classifyFileTreeEntry('x.toml', false, false)).toBe('file-config')
  })

  it('.env (dotfile-as-extension) -> file-config', () => {
    expect(classifyFileTreeEntry('.env', false, false)).toBe('file-config')
  })

  it('x.json -> file-data', () => {
    expect(classifyFileTreeEntry('x.json', false, false)).toBe('file-data')
  })

  it('x.yaml -> file-data', () => {
    expect(classifyFileTreeEntry('x.yaml', false, false)).toBe('file-data')
  })

  it('a directory named like an image extension still classifies as folder', () => {
    expect(classifyFileTreeEntry('image.png', true, false)).toBe('folder')
  })

  it('extension matching is case-insensitive: X.PNG -> file-image', () => {
    expect(classifyFileTreeEntry('X.PNG', false, false)).toBe('file-image')
  })

  it('x.rs -> file-code', () => {
    expect(classifyFileTreeEntry('x.rs', false, false)).toBe('file-code')
  })

  it('x.md -> file-text', () => {
    expect(classifyFileTreeEntry('x.md', false, false)).toBe('file-text')
  })

  it('x.unknown -> file', () => {
    expect(classifyFileTreeEntry('x.unknown', false, false)).toBe('file')
  })

  it('Makefile (no extension) -> file', () => {
    expect(classifyFileTreeEntry('Makefile', false, false)).toBe('file')
  })

  it('file-config and file-data resolve to distinct icons and tones', () => {
    expect(FILE_TREE_ICON_COMPONENT['file-config']).toBe(IconFileCog)
    expect(FILE_TREE_ICON_COMPONENT['file-data']).toBe(IconFileJson)
    expect(FILE_TREE_ICON_TONE_CLS['file-config']).toBe('text-info')
    expect(FILE_TREE_ICON_TONE_CLS['file-data']).toBe('text-warning')
  })
})
