import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { GhState, HoustonClient, PrInfo } from '../../houston/client'

export interface PrState {
  gh: GhState
  hasUpstream: boolean
  pr: PrInfo | null
  hint: string | null
}

export interface PrSubscriptionParams {
  client: HoustonClient | null
  repoDir: string | null
  base: string | null
  setPr: Dispatch<SetStateAction<PrState | null>>
  setPrBusy: Dispatch<SetStateAction<boolean>>
  setPrMessage: Dispatch<SetStateAction<string | null>>
}

export function usePrSubscription({
  client,
  repoDir,
  base,
  setPr,
  setPrBusy,
  setPrMessage
}: PrSubscriptionParams): void {
  // `base` is in the dep list even though `pr_status` never reads it: both doors
  // were one effect that re-fetched on every base change, and narrowing the list
  // now would be the behaviour change this extraction promised not to make.
  useEffect(() => {
    if (!client || !repoDir) return
    const unsubPrStatus = client.subscribe('pr_status', (msg) => {
      if (msg.dir !== repoDir) return
      setPr({
        gh: msg.gh,
        hasUpstream: msg.has_upstream,
        pr: msg.pr ?? null,
        hint: msg.hint ?? null
      })
    })
    const unsubPrCreate = client.subscribe('pr_create', (msg) => {
      if (msg.dir !== repoDir) return
      setPrBusy(false)
      setPrMessage(msg.message ?? null)
      if (msg.pr) {
        setPr((p) => ({
          ...(p ?? { hasUpstream: true, hint: null }),
          gh: msg.gh,
          pr: msg.pr ?? null,
          hasUpstream: p?.hasUpstream ?? true,
          hint: null
        }))
      }
    })
    client.prStatus(repoDir)
    return () => {
      unsubPrStatus()
      unsubPrCreate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters are stable identities, not real deps; mirrors the original effect's own [client, repoDir, base].
  }, [client, repoDir, base])
}
