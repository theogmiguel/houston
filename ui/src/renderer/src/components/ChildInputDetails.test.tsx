// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../houston/client'
import { withInputOwner, withPermissionOwner, withReportAsk } from '../test/inputFixtures'
import { askedOrchestrator, attentionLabel, attentionStatus, needsUserInput } from '../sessionAttention'
import { gridStatus } from './ui/railRows'
import { classifyChild } from '../childStatus'
import type { HoustonClient } from '../houston/client'
import { ChildInputBanner, ChildInputDetails, ParentOwnedInput } from './ChildInputDetails'

afterEach(cleanup)
const child = { id: 2, spawned_by: 1, state: 'running', status: 'needs-input', agent: 'claude', children_waiting: 0 } as SessionInfo

it('keeps parent-owned permission gray, with reported metadata and no operator banner', () => {
  const permission = withPermissionOwner(child, 'orchestrator')
  render(<><ParentOwnedInput info={permission} /><ChildInputDetails info={permission} /><ChildInputBanner info={permission} /></>)
  expect(screen.getByText('Blocked · asked orchestrator').className).toContain('text-[var(--text-muted)]')
  expect(screen.getByText(/Command: curl/).textContent).toContain('Authorization:[redacted]')
  expect(screen.getByText('Block reason: not reported by claude')).toBeTruthy()
  expect(screen.queryByRole('note')).toBeNull()
  expect(needsUserInput(permission)).toBe(false)
  expect(gridStatus([permission]).kind).toBe('idle')
  expect(attentionLabel(withInputOwner(child, 'orchestrator'))).toBe('Asked orchestrator')
})

it('shows the operator banner and orchestrator recommendation after escalation', () => {
  const permission = withPermissionOwner(child, 'user')
  render(<ChildInputBanner info={permission} />)
  expect(screen.getByRole('note').textContent).toContain('Needs you')
  expect(screen.getByText(/Orchestrator recommendation:/).textContent).toContain('Deny this command')
  expect(needsUserInput(permission)).toBe(true)
  expect(gridStatus([permission]).kind).toBe('needs-input')
})

it('names the provider when permission metadata was not reported and hides ended requests', () => {
  const permission = withPermissionOwner({ ...child, agent: 'cursor' }, 'user')
  const withoutDetails = { ...permission, delegation: { ...permission.delegation!, input_request: { ...permission.delegation!.input_request!, permission: undefined } } }
  const view = render(<ChildInputBanner info={withoutDetails} />)
  expect(screen.getByText('Command: not reported by cursor')).toBeTruthy()
  expect(screen.getByText('Block reason: not reported by cursor')).toBeTruthy()
  view.rerender(<ChildInputBanner info={{ ...withoutDetails, state: 'exited' }} />)
  expect(screen.queryByRole('note')).toBeNull()
})

it('preserves operator attention for an escalated descendant while this child asks its parent', () => {
  const permission = { ...withPermissionOwner(child, 'orchestrator'), children_waiting: 1 }
  expect(askedOrchestrator(permission)).toBe(false)
  expect(needsUserInput(permission)).toBe(true)
  expect(attentionStatus(permission)).toBe('needs-input')
  expect(attentionLabel(permission)).toBe('Needs you')
})

it('keeps an escalated report question amber while its child works, since the worker may be waiting on it', () => {
  const asked = withReportAsk(child, 'user')
  expect(needsUserInput(asked)).toBe(true)
  expect(attentionStatus(asked)).toBe('needs-input')
  expect(attentionLabel(asked)).toBe('Needs you')
  expect(classifyChild(asked).group).toBe('Needs you')
})

it('does not force a working child with a parent-owned report question to idle', () => {
  const asked = withReportAsk(child, 'orchestrator')
  expect(askedOrchestrator(asked)).toBe(true)
  expect(attentionStatus(asked)).toBe('working')
  expect(attentionLabel(asked)).toBe('Asked orchestrator')
  expect(classifyChild(asked).group).toBe('Waiting on orchestrator')
  const blocked = withPermissionOwner(child, 'orchestrator')
  expect(attentionStatus(blocked)).toBe('idle')
})

it('dismisses a report ask from the banner and offers no dismissal for a provider prompt', () => {
  const childInputResolve = vi.fn()
  const client = { childInputResolve } as unknown as HoustonClient
  const view = render(<ChildInputBanner info={withReportAsk(child, 'user')} client={client} />)
  expect(screen.getByRole('note').textContent).toContain('Needs you')
  screen.getByRole('button', { name: 'Dismiss' }).click()
  expect(childInputResolve).toHaveBeenCalledWith(2, 'report:7')
  view.unmount()
  render(<ChildInputBanner info={withPermissionOwner(child, 'user')} client={client} />)
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
})
