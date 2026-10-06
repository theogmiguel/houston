import { MAX_NOTICES, type NoticeStore } from '../notices'
import { NoticeEvictionCaption, NoticeToast, NoticeToastRegion, type NoticeToastAnchor } from './ui/NoticeToast'
import { OrchestrationNotice } from './ui/OrchestrationNotice'

export type NoticeAnchor = NoticeToastAnchor

export function NoticeStack({
  anchor,
  label,
  store
}: {
  anchor: NoticeAnchor
  label: string
  store: NoticeStore
}): React.JSX.Element | null {
  const rows = store.notices
  if (rows.length === 0) return null

  return (
    <NoticeToastRegion anchor={anchor} label={label}>
      {rows.map((n) => {
        if (n.presentation === 'orchestration') {
          return (
            <div key={n.id} data-notice={n.code}>
              <OrchestrationNotice
                heading={n.title}
                body={n.body ?? ''}
                needsInput={n.kind === 'warning'}
                onOpen={() => {
                  n.action?.onClick()
                  store.dismiss(n.code)
                }}
                onDismiss={() => store.dismiss(n.code)}
              />
            </div>
          )
        }
        return (
          <NoticeToast
            key={n.id}
            anchor={anchor}
            code={n.code}
            kind={n.kind}
            heading={n.title}
            body={n.body}
            action={n.action}
            onDismiss={n.dismissible ? () => store.dismiss(n.code) : undefined}
          />
        )
      })}
      {store.evicted > 0 && (
        <NoticeEvictionCaption>
          {store.evicted === 1
            ? `1 earlier notice dropped — the stack holds ${MAX_NOTICES}`
            : `${store.evicted} earlier notices dropped — the stack holds ${MAX_NOTICES}`}
        </NoticeEvictionCaption>
      )}
    </NoticeToastRegion>
  )
}
