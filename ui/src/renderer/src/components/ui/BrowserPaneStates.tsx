import { Button } from './Button'
import { variants } from './variants'
import { IconGlobe, IconHistory, IconPlug, IconPlus, IconRefresh, IconServer } from '../icons'
import { IconTile } from '../IconTile'
import type { LocalServer } from '../../houston/generated/LocalServer'
import { clearRecents, faviconInitial, hostLabel } from '../browserTabs'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { unreachableHost, unreachableMessage } from './browserUnreachable'
import { lastRunLabel } from '../nav/routineFormat'

const groupTitle = variants(
  'inline-flex items-center gap-[var(--space-1)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-muted)]',
  { icon: { server: '', history: '' } },
  { icon: 'server' }
)
const serverRow = 'btn group flex w-full items-center gap-[var(--space-2-5)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent px-[var(--space-2)] py-[var(--space-1-5)] text-left text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--card-bg)_80%,transparent)] hover:text-[var(--text-primary)]'

export interface BrowserRecent {
  url: string
  onOpen: () => void
}

export function BrowserBlankState({
  recents,
  servers,
  unsupported,
  truncated,
  onClear,
  onOpenPage,
  onOpenServer
}: {
  recents: BrowserRecent[]
  servers: LocalServer[]
  unsupported: string | null
  truncated: boolean
  onClear: () => void
  onOpenPage: () => void
  onOpenServer: (url: string) => void
}): React.JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center py-[var(--space-6)] px-[var(--space-4)] overflow-y-auto">
      <div className="w-full max-w-[300px] flex flex-col items-start gap-[var(--space-3)]">
        <IconTile icon={<span className="text-[var(--text-secondary)]"><IconGlobe /></span>} />
        <div className="flex flex-col gap-[var(--space-1)]">
          <h2 className="m-0 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)] leading-[1.2]">Browser</h2>
          <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-muted)]">Enter a URL, or open a server this workspace is running.</p>
        </div>
        <Button variant="outline" size="sm" icon={IconPlus} onClick={onOpenPage} data-testid="browser-pane-open-cta">Open a page</Button>
        {!unsupported && servers.length > 0 && (
          <div className="w-full flex flex-col gap-[var(--space-1)]" data-testid="browser-local-servers">
            <div className={groupTitle({ icon: 'server' })}><IconServer />Local servers</div>
            <div className="flex flex-col gap-px">
              {servers.map((server) => (
                <button key={`${server.port}-${server.session}`} type="button" className={serverRow} onClick={() => onOpenServer(`http://localhost:${server.port}/`)}>
                  <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--surface)] font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase text-[var(--text-muted)]">{server.port.toString()[0]}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="whitespace-nowrap overflow-hidden text-ellipsis [font-size:var(--tr-text-small-size)] font-medium">localhost:{server.port}</span>
                    <span className="whitespace-nowrap overflow-hidden text-ellipsis [font-size:var(--tr-text-label-size)] font-normal text-[var(--text-muted)]">{server.process} · {server.pane_title}</span>
                  </span>
                  <span className="inline-flex flex-none items-center gap-[var(--space-1)] [font-size:var(--tr-text-label-size)] text-[var(--status-done-text)]"><i className="h-1.5 w-1.5 rounded-full bg-[var(--status-done-text)]" />listening</span>
                </button>
              ))}
            </div>
            {truncated && <span className="pl-8 [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">Showing the first 32 local servers (limit).</span>}
          </div>
        )}
        {recents.length > 0 && (
          <div className="w-full flex flex-col gap-[var(--space-1)]">
            <div className={groupTitle({ icon: 'history' })}><IconHistory />Recently opened<Button variant="label" className="ml-auto" data-testid="browser-pane-clear-recents" onClick={onClear}>Clear</Button></div>
            <div className="flex flex-col gap-px">
              {recents.map(({ url, onOpen }) => (
                <button key={url} type="button" className={serverRow} onClick={onOpen}>
                  <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--surface)] font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase text-[var(--text-muted)]">{faviconInitial(url)}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="whitespace-nowrap overflow-hidden text-ellipsis [font-size:var(--tr-text-small-size)] font-medium">{hostLabel(url)}</span>
                    <span className="whitespace-nowrap overflow-hidden text-ellipsis [font-size:var(--tr-text-label-size)] font-normal text-[var(--text-muted)]">{url}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function BrowserUnreachableState({
  host,
  message,
  rawError,
  url,
  attempts,
  lastFailureAt,
  details,
  onRetry,
  onToggleDetails
}: {
  host: string
  message: string
  rawError: string
  url: string
  attempts: number
  lastFailureAt: number | null
  details: boolean
  onRetry: () => void
  onToggleDetails: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center py-[var(--space-6)] px-[var(--space-4)] overflow-y-auto" role="alert" data-testid="browser-unreachable-state">
      <div className="flex w-full max-w-[300px] flex-col items-start gap-[var(--space-3)]">
        <IconTile icon={<IconPlug />} tone="danger-outline" />
        <div className="flex flex-col gap-[var(--space-1)]">
          <h2 className="m-0 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)] leading-[1.2]">Can’t reach {host}</h2>
          <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-muted)]">{message}</p>
        </div>
        <div className="flex items-center gap-[var(--space-1-5)]">
          <Button variant="outline" size="sm" icon={IconRefresh} onClick={onRetry}>Retry</Button>
          <Button variant="label" onClick={onToggleDetails}>{details ? 'Hide details' : 'Show details'}</Button>
        </div>
        {details && <pre className="m-0 w-full box-border whitespace-pre-wrap rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-[var(--space-2-5)] py-[var(--space-2)] font-mono [font-size:var(--tr-text-label-size)] leading-[1.6] text-[var(--text-muted)]">{rawError}{'\n'}{url}{'\n'}{attempts} {attempts === 1 ? 'attempt' : 'attempts'} · last {lastFailureAt === null ? 'unknown time' : lastRunLabel(lastFailureAt, Date.now())}</pre>}
      </div>
    </div>
  )
}

export function BrowserPaneStageState({
  fresh,
  failMsg,
  url,
  attempts,
  lastFailureAt,
  details,
  recents,
  setRecents,
  servers,
  unsupported,
  truncated,
  urlRef,
  setFailMsg,
  setDetails,
  reload,
  openUrl
}: {
  fresh: boolean
  failMsg: string | null
  url: string
  attempts: number
  lastFailureAt: number | null
  details: boolean
  recents: string[]
  setRecents: Dispatch<SetStateAction<string[]>>
  servers: LocalServer[]
  unsupported: string | null
  truncated: boolean
  urlRef: RefObject<HTMLInputElement | null>
  setFailMsg: Dispatch<SetStateAction<string | null>>
  setDetails: Dispatch<SetStateAction<boolean>>
  reload: () => void
  openUrl: (url: string) => void
}): React.JSX.Element | null {
  if (fresh) {
    return (
      <BrowserBlankState
        recents={recents.map((recentUrl) => ({ url: recentUrl, onOpen: () => openUrl(recentUrl) }))}
        servers={servers}
        unsupported={unsupported}
        truncated={truncated}
        onClear={() => { clearRecents(); setRecents([]) }}
        onOpenPage={() => urlRef.current?.focus()}
        onOpenServer={openUrl}
      />
    )
  }
  if (failMsg === null) return <span className="browser-caption">Select element · click to hand it to the focused agent</span>
  return (
    <BrowserUnreachableState
      host={unreachableHost(url)}
      message={unreachableMessage(url, failMsg)}
      rawError={failMsg}
      url={url}
      attempts={attempts}
      lastFailureAt={lastFailureAt}
      details={details}
      onRetry={() => { setFailMsg(null); setDetails(false); reload() }}
      onToggleDetails={() => setDetails((visible) => !visible)}
    />
  )
}
