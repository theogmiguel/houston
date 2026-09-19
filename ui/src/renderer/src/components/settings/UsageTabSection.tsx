import { UsageSection, type UsageSummaryMsg } from '../UsageSection'
import { SectionHead } from './shared'

export interface UsageTabSectionProps {
  usage: UsageSummaryMsg | null
  usageLoading: boolean
  usageError: string | null
  onUsageRequest: (sinceMs: number, untilMs: number, refreshPricing: boolean) => void
}

export function UsageTabSection({
  usage,
  usageLoading,
  usageError,
  onUsageRequest
}: UsageTabSectionProps): React.JSX.Element {
  return (
    <>
      <SectionHead
        title="Usage"
        lede="What the agents you run here have spent, read from each CLI's own session files. Counts only — no prompt or reply text is read, kept or sent anywhere."
      />
      <UsageSection
        summary={usage}
        loading={usageLoading}
        error={usageError}
        onRequest={onUsageRequest}
      />
    </>
  )
}
