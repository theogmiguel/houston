import { describe, expect, test } from 'vitest'
import { isBackgroundAdmissionRefusal, parseControlAdmission } from './controlAdmission'

describe('parseControlAdmission', () => {
  test('names the message type and a directory that contains colons', () => {
    expect(parseControlAdmission('control_admission:git_branch:C:\\repo\\wt')).toEqual({ kind: 'git_branch', target: 'C:\\repo\\wt' })
  })
  test('names a type with no target', () => {
    expect(parseControlAdmission('control_admission:session_list')).toEqual({ kind: 'session_list', target: null })
  })
  test('accepts the bare context of a daemon that does not name the request', () => {
    expect(parseControlAdmission('control_admission')).toEqual({ kind: null, target: null })
  })
  test('ignores other contexts', () => {
    expect(parseControlAdmission('git_status')).toBeNull()
    expect(parseControlAdmission(null)).toBeNull()
    expect(parseControlAdmission('control_admissions')).toBeNull()
  })
})

describe('isBackgroundAdmissionRefusal', () => {
  test('covers the burst requests and not user actions or unnamed refusals', () => {
    expect(isBackgroundAdmissionRefusal('control_admission:git_branch:/r')).toBe(true)
    expect(isBackgroundAdmissionRefusal('control_admission:pr_status:/r')).toBe(true)
    expect(isBackgroundAdmissionRefusal('control_admission:git_commit:/r')).toBe(false)
    expect(isBackgroundAdmissionRefusal('control_admission')).toBe(false)
  })
})
