import type { ClientMsg, HoustonClient } from './client'
import type { TaskExternalLink } from './generated/TaskExternalLink'
import type { TaskTrackerProvider } from './generated/TaskTrackerProvider'

export type { TaskDomain } from './generated/TaskDomain'
export type { TaskProject } from './generated/TaskProject'
export type { TaskTrackerProvider } from './generated/TaskTrackerProvider'
export type { TaskTrackerWorkspaceSettings } from './generated/TaskTrackerWorkspaceSettings'
export type TaskTrackerLink = TaskExternalLink

export function isTaskTrackerProvider(value: unknown): value is TaskTrackerProvider {
  return value === 'github_issues' || value === 'notion' || value === 'slack'
}

export function sendTaskWire(client: Pick<HoustonClient, 'send'>, message: ClientMsg): void {
  client.send(message)
}

export function isPullRequestUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.port === '' && parsed.username === '' && parsed.password === '' && /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*(?:\/|$)/.test(parsed.pathname)
  } catch {
    return false
  }
}

export function linkIsPullRequest(link: TaskTrackerLink): boolean {
  return link.provider === 'github_issues' && link.source === 'pull_request' && isPullRequestUrl(link.url)
}
