// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  IDLE_QUIET_MS_DEFAULT,
  IDLE_QUIET_MS_MAX,
  IDLE_QUIET_MS_MIN,
  STACK_CAP_DEFAULT,
  STACK_CAP_MAX,
  STACK_CAP_MIN,
  idleQuietMsDefault,
  passKeysToTerminal,
  setIdleQuietMsDefault,
  setPaneCapsForTests,
  setPassKeysToTerminal,
  setStackCapacity,
  stackCapacity
} from './paneCaps'
import { MAX_STACK_TABS, isLayoutNode, leaf, stackPane, stackWith } from './layout/tree'
import type { SplitNode, StackNode } from './layout/tree'

beforeEach(() => {
  localStorage.clear()
  setPaneCapsForTests({
    passThrough: false,
    idleQuietMs: IDLE_QUIET_MS_DEFAULT,
    stackCap: STACK_CAP_DEFAULT
  })
})

describe('bounds are enforced at the setter, not at the reader', () => {
  it('refuses an out-of-range stack capacity rather than clamping it', () => {
    setStackCapacity(STACK_CAP_MAX + 1)
    expect(stackCapacity()).toBe(STACK_CAP_DEFAULT)
    setStackCapacity(STACK_CAP_MIN - 1)
    expect(stackCapacity()).toBe(STACK_CAP_DEFAULT)
    setStackCapacity(6)
    expect(stackCapacity()).toBe(6)
  })

  it('refuses an out-of-range idle-quiet window', () => {
    setIdleQuietMsDefault(IDLE_QUIET_MS_MAX + 1)
    expect(idleQuietMsDefault()).toBe(IDLE_QUIET_MS_DEFAULT)
    setIdleQuietMsDefault(IDLE_QUIET_MS_MIN - 1)
    expect(idleQuietMsDefault()).toBe(IDLE_QUIET_MS_DEFAULT)
    setIdleQuietMsDefault(1200)
    expect(idleQuietMsDefault()).toBe(1200)
  })

  it('persists each one under its own key, and reads back what it wrote', () => {
    setPassKeysToTerminal(true)
    setStackCapacity(7)
    setIdleQuietMsDefault(900)
    expect(localStorage.getItem('tr-pass-through-to-terminal')).toBe('1')
    expect(localStorage.getItem('tr-panes-per-stack')).toBe('7')
    expect(localStorage.getItem('tr-idle-quiet-ms')).toBe('900')
    expect(passKeysToTerminal()).toBe(true)
  })
})

function stackOf(n: number): StackNode {
  return stackPane(
    Array.from({ length: n }, (_, i) => leaf(i + 1, `p${i + 1}`)),
    0,
    'stk'
  )
}

function treeWithStack(n: number): SplitNode {
  return {
    kind: 'split',
    dir: 'row',
    children: [stackOf(n), leaf(99, 'p99')],
    weights: [0.5, 0.5]
  }
}

describe('settings-40 — the stack cap is the preference, not a constant', () => {
  it('MAX_STACK_TABS remains the DEFAULT (the 2026-08-22 decision is not reversed)', () => {
    expect(MAX_STACK_TABS).toBe(STACK_CAP_DEFAULT)
    expect(stackCapacity()).toBe(MAX_STACK_TABS)
  })

  it('a 5th tab is refused at the default and accepted once the cap is raised', () => {
    const tree = treeWithStack(4)

    expect(stackWith(tree, 1, 99)).toBe(tree)

    setStackCapacity(6)
    const after = stackWith(tree, 1, 99)
    expect(after).not.toBe(tree)
    const stack = after.kind === 'stack' ? after : ((after as SplitNode).children[0] as StackNode)
    expect(stack.kind).toBe('stack')
    expect(stack.children).toHaveLength(5)
  })

  it('a LOWERED cap refuses the next add without invalidating a layout already over it', () => {
    const tree = treeWithStack(4)
    setStackCapacity(2)
    expect(stackWith(tree, 1, 99)).toBe(tree)
    expect(isLayoutNode(tree)).toBe(true)
  })

  it('the validator accepts a stack built at the highest cap the app allows', () => {
    expect(isLayoutNode(stackOf(STACK_CAP_MAX))).toBe(true)
    expect(isLayoutNode(stackOf(STACK_CAP_MAX + 1))).toBe(false)
  })
})

describe('settings-01 — the idle-quiet default reaches the wire', () => {
  it('is what a wait_for_idle with no explicit window sends', async () => {
    setIdleQuietMsDefault(1500)
    const sent: Record<string, unknown>[] = []
    const { HoustonClient } = await import('./houston/client')
    const c = Object.create(HoustonClient.prototype) as {
      waitForIdle: (s: number, t?: number, q?: number) => Promise<boolean>
      send: (m: Record<string, unknown>) => void
      idleSeq: number
      idleWaiters: Map<number, unknown>
    }
    c.idleSeq = 0
    c.idleWaiters = new Map()
    c.send = (m: Record<string, unknown>) => sent.push(m)

    void c.waitForIdle(7)
    expect(sent[0]?.idle_quiet_ms).toBe(1500)

    void c.waitForIdle(7, 3000, 250)
    expect(sent[1]?.idle_quiet_ms).toBe(250)
  })
})
