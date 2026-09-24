// The renderer's in-memory view of a directory's checkout, as the `git_branch`
// reply carries it. Nothing is persisted: a fact lives for the connection that
// received it, and `null` means git had no answer, never "unknown value".

import { isLive, type SessionInfo } from './houston/client'

export interface CheckoutFacts {
  branch: string | null
  toplevel: string | null
  common_dir: string | null
}

interface CheckoutEntry {
  session: SessionInfo
  toplevel: string
  commonDir: string
}

// Live panes only: an exited session has no branch to move, and a remote pane
// has no local checkout. A missing toplevel or common dir is "unknown" and is
// excluded rather than guessed at.
function liveCheckoutEntries(
  sessions: Iterable<SessionInfo>,
  facts: ReadonlyMap<string, CheckoutFacts>,
  dirOf: (session: SessionInfo) => string
): CheckoutEntry[] {
  const out: CheckoutEntry[] = []
  for (const session of sessions) {
    if (!isLive(session.state) || session.agent === 'ssh') continue
    const fact = facts.get(dirOf(session))
    if (!fact?.toplevel || !fact.common_dir) continue
    out.push({ session, toplevel: fact.toplevel, commonDir: fact.common_dir })
  }
  return out
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/** The chip tooltip's note per session: which other live panes share this
 * pane's checkout, and which sit in another checkout of the same repository.
 * Information to consult, never an alert. */
export function checkoutNotes(
  sessions: Iterable<SessionInfo>,
  facts: ReadonlyMap<string, CheckoutFacts>,
  dirOf: (session: SessionInfo) => string,
  workspaceName: (path: string) => string
): Map<number, string> {
  const entries = liveCheckoutEntries(sessions, facts, dirOf)
  const notes = new Map<number, string>()
  for (const entry of entries) {
    const others = entries.filter((other) => other.session.id !== entry.session.id)
    const sameCheckout = others.filter((other) => other.toplevel === entry.toplevel)
    const sameRepository = others.filter(
      (other) => other.commonDir === entry.commonDir && other.toplevel !== entry.toplevel
    )
    const lines: string[] = []
    if (sameCheckout.length > 0) {
      lines.push(`Also in this checkout: ${sameCheckout.map((o) => o.session.title).join(', ')}`)
    }
    if (sameRepository.length > 0) {
      const labels = [
        ...new Set(
          sameRepository.map(
            (o) => workspaceName(o.session.project_dir) || basename(o.toplevel)
          )
        )
      ]
      lines.push(`Same repository: ${labels.join(', ')}`)
    }
    if (lines.length > 0) notes.set(entry.session.id, lines.join('\n'))
  }
  return notes
}
