// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxRow } from './houston/client'
import type { DelegationInfo } from './houston/generated/DelegationInfo'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

let harness: AppHarness | null = null

afterEach(() => {
  harness?.unmount()
  harness = null
  vi.useRealTimers()
})

let nextId = 100

function owedRow(over: Partial<InboxRow> = {}): InboxRow {
  nextId += 1
  return {
    id: BigInt(nextId),
    to_session: 0,
    original_to: 41,
    workspace: '/tmp/project',
    from_session: 58,
    request_id: 1,
    kind: 'result',
    urgent: false,
    summary: 'Migration script ran clean, 0 rows skipped.',
    body: 'Full body: the migration ran clean with 0 rows skipped.',
    artifacts: [],
    superseded: 0,
    provisional: false,
    corrects: null,
    reason: 'parent_dead',
    created_at: BigInt(Date.now()),
    ready_at: null,
    resolved_at: null,
    delivered_at: null,
    delivered_via: null,
    confirmed_at: null,
    attempts: 0,
    ...over
  } as InboxRow
}

function bellButton(h: AppHarness): HTMLButtonElement {
  const btn = Array.from(h.container.querySelectorAll('button')).find((b) =>
    b.className.includes('bell-btn')
  )
  if (!btn) throw new Error('bell button not found')
  return btn as HTMLButtonElement
}

function openBell(h: AppHarness): void {
  act(() => {
    bellButton(h).click()
  })
}

function owedRows(h: AppHarness): HTMLElement[] {
  return Array.from(h.container.querySelectorAll('[data-testid^="owed-row-"]'))
}

function parentAndChild(): ReturnType<typeof makeSession>[] {
  return [
    makeSession({ id: 41, title: 'Fix the flaky late attach flood today', codename: 'oak' }),
    makeSession({
      id: 58,
      title: 'slate-lantern',
      codename: 'fern',
      spawned_by: 41,
      delegation: { parent: 41, role: 'reviewer' } as DelegationInfo
    })
  ]
}

describe('the operator inbox bell surface', () => {
  it('keeps the sender identity after the temporary pane is removed', async () => {
    harness = await renderReadyApp({ sessions: [], workspaces: [makeWorkspace()] })
    const row = owedRow({ from_codename: 'fern', from_role: 'reviewer' })
    deliverControl({ type: 'inbox_rows', workspace: '/tmp/project', rows: [row] })
    openBell(harness)

    expect(owedRows(harness)[0].textContent).toContain('[result] fern · reviewer → #41')
    expect(owedRows(harness)[0].textContent).not.toContain('Jump to pane')
  })

  it('uses the identity recorded with the result when the live role has changed', async () => {
    harness = await renderReadyApp({
      sessions: parentAndChild(),
      workspaces: [makeWorkspace()]
    })
    const row = owedRow({ from_codename: 'fern', from_role: 'migration' })
    deliverControl({ type: 'inbox_rows', workspace: '/tmp/project', rows: [row] })
    openBell(harness)

    expect(owedRows(harness)[0].textContent).toContain('fern · migration')
    expect(owedRows(harness)[0].textContent).not.toContain('fern · reviewer')
  })

  it('rows_outlive_every_pane_involved: rows render with both panes gone from the roster', async () => {
    harness = await renderReadyApp({ sessions: [], workspaces: [makeWorkspace()] })
    const row = owedRow()
    deliverControl({ type: 'inbox_rows', workspace: '/tmp/project', rows: [row] })
    openBell(harness)
    const rows = owedRows(harness)
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('[result] #58 → #41')
    expect(
      rows[0].textContent?.includes('Jump to pane')
    ).toBe(false)
    expect(currentClient().inboxList).toHaveBeenCalledWith('/tmp/project')
  })

  it('reading_is_not_resolving: Open sends ack and not resolve, the row loses its unread tint and keeps its Resolve', async () => {
    harness = await renderReadyApp({
      sessions: parentAndChild(),
      workspaces: [makeWorkspace()]
    })
    const row = owedRow({ kind: 'needs_input', original_to: null })
    deliverControl({ type: 'inbox_rows', workspace: '/tmp/project', rows: [row] })
    openBell(harness)
    const el = owedRows(harness)[0]
    expect(el.textContent).toContain('fern · reviewer')
    expect(el.classList.contains('border-l-2')).toBe(true)
    const open = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent === 'Open'
    )
    expect(open).toBeTruthy()
    act(() => {
      open!.click()
    })
    expect(currentClient().inboxAck).toHaveBeenCalledWith(row.id)
    expect(currentClient().inboxResolve).not.toHaveBeenCalled()
    deliverControl({
      type: 'inbox_changed',
      workspace: '/tmp/project',
      row: { ...row, delivered_at: Date.now(), delivered_via: 'operator' }
    })
    const after = owedRows(harness)[0]
    expect(after.classList.contains('border-l-2')).toBe(false)
    expect(
      Array.from(after.querySelectorAll('button')).some((b) => b.textContent === 'Resolve')
    ).toBe(true)
  })

  it('jumping_to_a_cross_workspace_original_target_selects_the_target_workspace', async () => {
    const source = '/tmp/project'
    const target = '/tmp/other'
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 41, project_dir: target, cwd: target, title: 'parent' }),
        makeSession({ id: 58, project_dir: source, cwd: source, title: 'child' })
      ],
      workspaces: [
        makeWorkspace({ path: source, name: 'project' }),
        makeWorkspace({ path: target, name: 'other' })
      ]
    })
    const row = owedRow({ workspace: source, original_to: 41, from_session: 58 })
    deliverControl({ type: 'inbox_rows', workspace: source, rows: [row] })
    openBell(harness)
    const jump = Array.from(owedRows(harness)[0].querySelectorAll('button')).find(
      (b) => b.textContent === 'Jump to pane'
    )
    expect(jump).toBeTruthy()

    act(() => jump!.click())

    const selected = Array.from(
      harness.container.querySelectorAll<HTMLElement>('.witem[aria-current="true"]')
    )
    expect(selected.some((item) => item.textContent?.includes('other'))).toBe(true)
    expect(selected.some((item) => item.textContent?.includes('project'))).toBe(false)
  })

  it('jumping_to_a_cross_workspace_sender_uses_the_sender_workspace_when_no_original_target_exists', async () => {
    const source = '/tmp/project'
    const target = '/tmp/other'
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 41, project_dir: source, cwd: source, title: 'parent' }),
        makeSession({ id: 58, project_dir: target, cwd: target, title: 'child' })
      ],
      workspaces: [
        makeWorkspace({ path: source, name: 'project' }),
        makeWorkspace({ path: target, name: 'other' })
      ]
    })
    const row = owedRow({ workspace: source, original_to: null, from_session: 58 })
    deliverControl({ type: 'inbox_rows', workspace: source, rows: [row] })
    openBell(harness)
    const jump = Array.from(owedRows(harness)[0].querySelectorAll('button')).find(
      (b) => b.textContent === 'Jump to pane'
    )
    expect(jump).toBeTruthy()

    act(() => jump!.click())

    const selected = Array.from(
      harness.container.querySelectorAll<HTMLElement>('.witem[aria-current="true"]')
    )
    expect(selected.some((item) => item.textContent?.includes('other'))).toBe(true)
    expect(selected.some((item) => item.textContent?.includes('project'))).toBe(false)
  })

  it('a_corrected_row_is_struck_and_links_to_its_correction', async () => {
    harness = await renderReadyApp({
      sessions: parentAndChild(),
      workspaces: [makeWorkspace()]
    })
    const old = owedRow({ id: BigInt(118), summary: 'Migration script ran clean.' })
    const correction = owedRow({
      id: BigInt(124),
      summary: 'Migration script hit 2 row conflicts after all.',
      corrects: 118
    })
    deliverControl({ type: 'inbox_rows', workspace: '/tmp/project', rows: [old, correction] })
    openBell(harness)
    const struck = harness.container.querySelector('[data-testid="owed-row-118"]')
    expect(struck?.querySelector('.line-through')?.textContent).toContain(
      'Migration script ran clean.'
    )
    const link = Array.from(struck?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('corrected by #124')
    )
    expect(link).toBeTruthy()
    const fix = harness.container.querySelector('[data-testid="owed-row-124"]')
    expect(fix?.textContent).toContain('corrects #118')
    act(() => {
      link!.click()
    })
    expect(
      harness.container
        .querySelector('[data-testid="owed-row-124"]')
        ?.getAttribute('style')
    ).toContain('selected-fill')
  })

  it('a_provisional_row_carries_its_marker', async () => {
    harness = await renderReadyApp({
      sessions: parentAndChild(),
      workspaces: [makeWorkspace()]
    })
    deliverControl({
      type: 'inbox_rows',
      workspace: '/tmp/project',
      rows: [owedRow({ provisional: true })]
    })
    openBell(harness)
    expect(owedRows(harness)[0].textContent).toContain('may be corrected')
  })

  it('clear_all_resolves_every_owed_row_whatever_its_kind', async () => {
    harness = await renderReadyApp({
      sessions: parentAndChild(),
      workspaces: [makeWorkspace()]
    })
    deliverControl({ type: 'agent_notice', session: 41, kind: 'finished' })
    const result = owedRow({ kind: 'result' })
    const noHandback = owedRow({ kind: 'no_handback', delivered_at: Date.now() })
    deliverControl({
      type: 'inbox_rows',
      workspace: '/tmp/project',
      rows: [result, noHandback]
    })
    openBell(harness)
    expect(owedRows(harness)).toHaveLength(2)
    const clear = Array.from(harness.container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Clear all'
    )
    expect(clear).toBeTruthy()
    act(() => {
      clear!.click()
    })
    expect(currentClient().inboxResolve).toHaveBeenCalledWith(result.id)
    expect(currentClient().inboxResolve).toHaveBeenCalledWith(noHandback.id)
    for (const row of [result, noHandback])
      deliverControl({
        type: 'inbox_changed',
        workspace: '/tmp/project',
        row: { ...row, resolved_at: Date.now() }
      })
    expect(owedRows(harness)).toHaveLength(0)
  })

  it('a_row_addressed_to_a_pane_never_reaches_the_bell', async () => {
    harness = await renderReadyApp({
      sessions: parentAndChild(),
      workspaces: [makeWorkspace()]
    })
    const toParent = owedRow({ to_session: 41, original_to: null, reason: null })
    deliverControl({ type: 'inbox_changed', workspace: '/tmp/project', row: toParent })
    openBell(harness)
    expect(owedRows(harness)).toHaveLength(0)
    const badge = harness.container.querySelector('.pulse-ring-badge')
    expect(badge).toBeNull()
  })

  it('the_bell_count_includes_owed_rows', async () => {
    harness = await renderReadyApp({
      sessions: parentAndChild(),
      workspaces: [makeWorkspace()]
    })
    deliverControl({
      type: 'inbox_rows',
      workspace: '/tmp/project',
      rows: [owedRow({ kind: 'needs_input', original_to: null })]
    })
    const badge = harness.container.querySelector('.pulse-ring-badge')
    expect(badge?.textContent).toBe('1')
    expect(bellButton(harness).getAttribute('data-attention')).toBe('waiting')
  })
})
