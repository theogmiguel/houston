import { describe, expect, it } from 'vitest'
import {
  normalizeWorkspacePath,
  workspaceRefusal,
  WORKSPACE_REFUSAL_RULE
} from './workspaceEligibility'

describe('workspaceRefusal', () => {
  it('accepts an ordinary project folder', () => {
    expect(workspaceRefusal('/home/dev/projects/houston')).toBeNull()
  })

  it('refuses the disk root, with or without a trailing slash', () => {
    for (const p of ['/', '//']) {
      expect(workspaceRefusal(p)).toContain(WORKSPACE_REFUSAL_RULE)
    }
  })

  it('accepts the home folder and a folder inside it', () => {
    expect(workspaceRefusal('/home/dev')).toBeNull()
    expect(workspaceRefusal('/home/dev/')).toBeNull()
    expect(workspaceRefusal('/home/dev/code')).toBeNull()
  })

  it('refuses credential directories — the ones no keyword catches', () => {
    for (const p of ['/home/dev/.ssh', '/home/dev/.gnupg', '/home/dev/.aws', '/home/dev/.ssh/keys']) {
      expect(workspaceRefusal(p), p).toContain(WORKSPACE_REFUSAL_RULE)
    }
  })

  it('refuses secret-shaped paths on the same list the git pane redacts by', () => {
    for (const p of ['/home/dev/secrets', '/srv/credentials', '/home/dev/app/.env.local']) {
      expect(workspaceRefusal(p), p).toContain(WORKSPACE_REFUSAL_RULE)
    }
  })

  it('names the exact path that was refused, not a generic failure', () => {
    const message = workspaceRefusal('/home/dev/.ssh')
    expect(message).toContain('/home/dev/.ssh')
  })

})

describe('normalizeWorkspacePath', () => {
  it('keeps the root as "/" rather than collapsing it to the empty string', () => {
    expect(normalizeWorkspacePath('/')).toBe('/')
    expect(normalizeWorkspacePath('/a/b/')).toBe('/a/b')
  })
})
