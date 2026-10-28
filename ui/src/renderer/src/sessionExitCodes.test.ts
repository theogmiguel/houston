import { describe, expect, it } from 'vitest'
import {
  forgetSessionExitCode,
  readSessionExitCode,
  rememberSessionExitCode,
  resetSessionExitCodes
} from './sessionExitCodes'

describe('session exit codes', () => {
  it('keeps the last code per session and clears it on forget', () => {
    resetSessionExitCodes()
    rememberSessionExitCode(7, 3)
    expect(readSessionExitCode(7)).toBe(3)
    rememberSessionExitCode(7, 0)
    expect(readSessionExitCode(7)).toBe(0)
    forgetSessionExitCode(7)
    expect(readSessionExitCode(7)).toBeUndefined()
  })

  it('distinguishes a reported null from a session that never reported', () => {
    resetSessionExitCodes()
    expect(readSessionExitCode(8)).toBeUndefined()
    rememberSessionExitCode(8, null)
    expect(readSessionExitCode(8)).toBeNull()
  })
})
