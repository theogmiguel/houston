import { useMemo } from 'react'
import { PullRequestTab } from '../src/components/git/PullRequestTab'
import type { HoustonClient } from '../src/houston/client'
import { InspectorClient } from './inspectorStories'

export function PrPanelStory({ failing = false, metadataMissing = false, ageSeconds = 720, state = 'open', isDraft = false }: { failing?: boolean; metadataMissing?: boolean; ageSeconds?: number; state?: 'open' | 'merged' | 'closed'; isDraft?: boolean }): React.JSX.Element {
  const client = useMemo(() => new InspectorClient(failing, true, { number: 95, state, isDraft, metadataMissing, ageSeconds }), [failing, state, isDraft, metadataMissing, ageSeconds])
  return <div className="flex h-full min-h-0 w-[470px]"><PullRequestTab client={client as unknown as HoustonClient} dir="/repo" compact onOpenUrlInPane={() => {}} /></div>
}
