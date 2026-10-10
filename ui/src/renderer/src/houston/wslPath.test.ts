import { describe, expect, it } from 'vitest'
import { parseWslPath, wslUncPath } from './wslPath'

describe('wslPath', () => {
  it('parses wsl unc paths', () => {
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\p')).toEqual({ distro: 'Ubuntu', path: '/home/u/p' })
    expect(parseWslPath('\\\\WSL$\\Ubuntu\\home\\u\\p\\')).toEqual({ distro: 'Ubuntu', path: '/home/u/p' })
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu')).toEqual({ distro: 'Ubuntu', path: '/' })
    expect(parseWslPath('C:\\x')).toBeNull()
  })

  it('reads the canonical UNC form and a distro root with a trailing backslash', () => {
    expect(parseWslPath('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\u\\p\\a.txt')).toEqual({
      distro: 'Ubuntu',
      path: '/home/u/p/a.txt'
    })
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\')).toEqual({ distro: 'Ubuntu', path: '/' })
    expect(parseWslPath('\\\\server\\share\\x')).toBeNull()
    expect(parseWslPath('/home/u/p')).toBeNull()
  })

  it('builds the wsl.localhost path for a posix path', () => {
    expect(wslUncPath('Ubuntu', '/home/u/p')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u\\p')
    expect(wslUncPath('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu\\')
  })
})
