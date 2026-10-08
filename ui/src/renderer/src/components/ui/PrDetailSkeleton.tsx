import { LoadingPlaceholderLine } from './MarkdownContent'

export function PrDetailSkeleton(): React.JSX.Element {
  return (
    <div data-testid="pr-loading" role="status" aria-label="Loading pull request" className="flex-1 min-h-0 px-4 py-3">
      <div aria-hidden="true" className="flex flex-col gap-3">
        <LoadingPlaceholderLine className="w-1/3" />
        <LoadingPlaceholderLine className="w-4/5" />
        <LoadingPlaceholderLine className="w-1/2" />
        <div className="flex gap-2 pt-2">
          <LoadingPlaceholderLine className="w-16" />
          <LoadingPlaceholderLine className="w-16" />
          <LoadingPlaceholderLine className="w-16" />
        </div>
        <LoadingPlaceholderLine className="w-full" />
        <LoadingPlaceholderLine className="w-11/12" />
        <LoadingPlaceholderLine className="w-3/4" />
      </div>
    </div>
  )
}
