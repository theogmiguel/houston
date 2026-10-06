import { BTN_GHOST } from './buttonChrome'
import { Text } from './Text'

/** What a surface shows when it crashed: the message, what survived, and a retry. */
export function SurfaceCrash({
  message,
  guarantee,
  onRetry
}: {
  message: string
  guarantee: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-2.5 p-4 text-center">
      <Text as="p" size="ui" weight="ui" tone="danger" flush>{message}</Text>
      <Text as="p" size="ui" tone="muted" flush>{guarantee}</Text>
      <button className={`btn ${BTN_GHOST}`} onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}
