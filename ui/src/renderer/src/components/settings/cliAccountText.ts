import type { AgentAccountIdentity } from '../../houston/generated/AgentAccountIdentity'

export function identityLabel(row: AgentAccountIdentity, withDetail = false): string {
  if (row.sign_in === 'signed_out') return 'Not signed in'
  if (row.sign_in === 'unknown') return 'Sign-in unknown'
  if (row.identity) return withDetail && row.detail ? `${row.identity} · ${row.detail}` : row.identity
  if (row.providers.length > 0) return `Signed in: ${row.providers.join(', ')}`
  return row.verified ? 'Signed in' : 'Signed in (unverified)'
}

export function accountRow(
  accounts: AgentAccountIdentity[] | null | undefined,
  agent: string,
  profileId: number | null
): AgentAccountIdentity | undefined {
  return accounts?.find((row) => row.agent === agent && (row.profile_id ?? null) === profileId)
}

/** One-line summary of every account a CLI has; `activeProfileId` is the account new panes use. */
export function accountSummary(
  accounts: AgentAccountIdentity[],
  agent: string,
  activeProfileId: number | null
): string {
  const rows = accounts.filter((row) => row.agent === agent)
  if (rows.length === 0) return 'Sign-in unknown'
  if (rows.length === 1) return identityLabel(rows[0])
  const signedIn = rows.filter((row) => row.sign_in === 'signed_in')
  if (signedIn.length === 0) return identityLabel(rows[0])
  const used = rows.find((row) => (row.profile_id ?? null) === activeProfileId)
  const count = `${signedIn.length} account${signedIn.length === 1 ? '' : 's'}`
  if (!used || used.sign_in !== 'signed_in') return `${count} · new panes use an account that is not signed in`
  return `${count} · ${identityLabel(used)} is used for new panes`
}
