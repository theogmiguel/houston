import { useEffect, useState } from 'react'
import { BTN_GHOST_BG } from './buttonChrome'

function ReconnectAge({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <>{Math.max(0, Math.round((now - since) / 1000))}s</>
}

export function ReconnectBanner({ since, error, onRetry }: { since: number; error: string | null; onRetry: () => void }): React.JSX.Element {
  return <div className="fixed top-[calc(var(--h-top)+16px)] left-1/2 -translate-x-1/2 z-[var(--z-toast)] flex items-center gap-2 py-1.5 px-3.5 border border-[var(--status-blocked-text)] rounded-full bg-[var(--card-bg)] text-[var(--status-blocked-text)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] shadow-[var(--shadow-md)] max-w-[70vw]" role="status">
    <span className="loop-anim flex-none w-2 h-2 rounded-[50%] bg-[var(--danger)] [--dot-pulse-opacity:0.25] motion-safe:[animation:dot-pulse_1.2s_steps(4,end)_infinite]" />
    <span>daemon connection lost — reconnecting… <ReconnectAge since={since} />{error ? ` (${error})` : ''}</span>
    <button className={`btn ${BTN_GHOST_BG} text-inherit border border-current py-px px-2 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]`} onClick={onRetry}>Retry now</button>
  </div>
}
