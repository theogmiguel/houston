import type { ForgeAccess } from '../../houston/client'

export interface ForgeBlock {
  /** Which state blocks the tab, for tests and styling. */
  kind: 'gh_missing' | 'gh_unauthenticated' | 'off' | 'no_token' | 'keychain_unavailable' | 'unsupported'
  headline: string
  body: string
}

/** Why the Pull request tab cannot read anything here, or `null` when it can. */
export function forgeBlocked(access: ForgeAccess, hint: string | null): ForgeBlock | null {
  switch (access.forge) {
    case 'github':
      if (access.gh === 'ready') return null
      return access.gh === 'missing'
        ? {
            kind: 'gh_missing',
            headline: 'GitHub CLI not found',
            body: hint ?? 'gh is not on PATH, so Houston cannot read pull requests. Install it and press Retry — nothing else in source control depends on it.'
          }
        : {
            kind: 'gh_unauthenticated',
            headline: 'GitHub CLI needs authentication',
            body: hint ?? 'gh is not authenticated, so Houston cannot read pull requests.'
          }
    case 'bitbucket':
      switch (access.state) {
        case 'ready':
          return null
        case 'off':
          return {
            kind: 'off',
            headline: 'Bitbucket Cloud pull requests are off',
            body: 'Houston sends nothing to Bitbucket until you turn on Read Bitbucket Cloud pull requests in Settings ▸ Accounts.'
          }
        case 'no_token':
          return {
            kind: 'no_token',
            headline: 'No Bitbucket API token',
            body: 'Add a Bitbucket API token in Settings ▸ Accounts, then press Retry.'
          }
        case 'keychain_unavailable':
          return {
            kind: 'keychain_unavailable',
            headline: 'OS keychain unavailable',
            body: hint ?? 'Houston keeps the Bitbucket API token only in the OS keychain, which is not answering.'
          }
      }
      return null
    case 'unsupported':
      return {
        kind: 'unsupported',
        headline: `Pull requests on ${access.host} are not supported`,
        body: hint ?? 'Houston reads pull requests from GitHub through gh and from Bitbucket Cloud.'
      }
  }
}
