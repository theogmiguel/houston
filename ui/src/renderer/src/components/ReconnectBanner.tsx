import { MascotSurfaceMount } from '../mascot/MascotMount'
import { useEffect, useState } from 'react'
import { ConnectionBanner } from './ui/ConnectionBanner'

function ReconnectAge({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <>{Math.max(0, Math.round((now - since) / 1000))}s</>
}

export function ReconnectBanner({ since, error, onRetry }: { since: number; error: string | null; onRetry: () => void }): React.JSX.Element {
  return (
    <>
    <MascotSurfaceMount mood="call" placement="reconnect" />
    <ConnectionBanner
      message={<>daemon connection lost — reconnecting… <ReconnectAge since={since} />{error ? ` (${error})` : ''}</>}
      actionLabel="Retry now"
      onAction={onRetry}
    /></>
  )
}
