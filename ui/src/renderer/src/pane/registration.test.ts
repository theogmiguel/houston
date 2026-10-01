import { describe, expect, it } from 'vitest'
import { claimVisibility, registerOwned } from './registration'

describe('terminal registration ownership', () => {
  it('an old disposer cannot delete its successor output sink', () => {
    const sinks = new Map<number, object>()
    const dispose = registerOwned(sinks, 7, {})
    const next = {}
    const disposeNext = registerOwned(sinks, 7, next)
    dispose()
    expect(sinks.get(7)).toBe(next)
    disposeNext()
    expect(sinks.has(7)).toBe(false)
  })
  it('guards even when two mounts register the same sink object', () => {
    const sinks = new Map<number, object>()
    const sink = {}
    const old = registerOwned(sinks, 7, sink)
    registerOwned(sinks, 7, sink)
    old()
    expect(sinks.get(7)).toBe(sink)
  })
  it('an old mount cannot change visibility or release its successor', () => {
    const client = {}
    const old = claimVisibility(client, 7)
    const next = claimVisibility(client, 7)
    expect(old.owns()).toBe(false)
    old.release()
    expect(next.owns()).toBe(true)
    next.release()
    expect(next.owns()).toBe(false)
  })
  it('visibility owners are independent across clients and sessions', () => {
    const client = {}
    const a = claimVisibility(client, 1)
    claimVisibility(client, 2)
    claimVisibility({}, 1)
    expect(a.owns()).toBe(true)
  })
})
