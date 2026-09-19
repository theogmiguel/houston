import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GhState,
  HoustonClient,
  PrAction,
  PrCommentKind,
  PrDetail,
  PrLabelCandidate,
  PrListItem,
  PrListInvolvement,
  PrListState,
  PrMergeMethod,
  PrReaction,
  PrReviewDraft,
  PrReviewer,
  PrReviewerCandidate,
  PrReviewVerdict,
  PrStack,
  PrStackHead,
  PrUpdateMethod,
  PullRequestLink
} from '../../houston/client'

export interface PrDetailView {
  gh: GhState
  hasUpstream: boolean
  link: PullRequestLink | null
  detail: PrDetail | null
  linked: boolean
  hint: string | null
  message: string | null
}

/** The one write in flight, its last failure, and any words a success carried. */
export interface PrWriteState {
  busy: string | null
  message: string | null
  notice: string | null
}

export interface PrDiffView {
  number: number
  patch: string
  truncated: boolean
  message: string | null
}

export interface PrDetailController {
  view: PrDetailView | null
  busy: boolean
  linkBusy: boolean
  mergeBusy: boolean
  createBusy: boolean
  linkMessage: string | null
  mergeMessage: string | null
  createMessage: string | null
  /** Which pull request the panel is showing: a number, or null for the branch's. */
  viewed: number | null
  write: PrWriteState
  reviewers: PrReviewerCandidate[] | null
  reviewersBusy: boolean
  reviewersMessage: string | null
  labels: PrLabelCandidate[] | null
  labelsBusy: boolean
  labelsMessage: string | null
  diff: PrDiffView | null
  diffBusy: boolean
  /** The host's own stack, once asked for; `null` before and when there is none. */
  stack: PrStack | null
  stackChecked: boolean
  stackBusy: boolean
  stackMessage: string | null
  refresh: () => void
  show: (number: number) => void
  showBranch: () => void
  link: (number: number) => void
  unlink: () => void
  create: () => void
  merge: (number: number, method: PrMergeMethod, expectedHeadSha: string) => void
  edit: (number: number, title: string | null, body: string | null) => void
  comment: (number: number, body: string) => void
  commentEdit: (number: number, commentId: string, kind: PrCommentKind, body: string) => void
  review: (number: number, verdict: PrReviewVerdict, body: string, drafts: PrReviewDraft[]) => void
  threadReply: (number: number, threadId: string, body: string) => void
  threadResolve: (number: number, threadId: string, resolved: boolean) => void
  react: (number: number, subjectId: string | null, content: PrReaction, reacted: boolean) => void
  reviewerSet: (number: number, reviewers: PrReviewer[], requested: boolean) => void
  /** Both directions of a reviewer change, one request each, in order. */
  reviewerApply: (number: number, added: PrReviewer[], removed: PrReviewer[]) => void
  labelSet: (number: number, labels: string[], applied: boolean) => void
  action: (
    number: number,
    action: PrAction,
    opts?: { mergeMethod?: PrMergeMethod; updateMethod?: PrUpdateMethod }
  ) => void
  loadReviewers: (number: number) => void
  loadLabels: (number: number) => void
  loadDiff: (number: number) => void
  loadStack: (number: number) => void
  mergeStack: (number: number, stackNumber: number, heads: PrStackHead[], method: PrMergeMethod) => void
}

export interface PrListController {
  items: PrListItem[] | null
  busy: boolean
  loadingMore: boolean
  truncated: boolean
  message: string | null
  /** The filters the last successful read used, so Load more asks the same question. */
  state: PrListState
  involvement: PrListInvolvement
  query: string
  setFilters: (next: {
    state?: PrListState
    involvement?: PrListInvolvement
    query?: string
  }) => void
  load: () => void
  loadMore: () => void
}

export const PR_LIST_PAGE = 25
export const PR_LIST_PAGE_MAX = 100

/** Owns the tab's reading and its verbs; request ids make stale replies drop. */
export function usePrDetail(
  client: HoustonClient | null,
  dir: string | null,
  active: boolean,
  refreshSignal: number
): PrDetailController {
  const [view, setView] = useState<PrDetailView | null>(null)
  const [busy, setBusy] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [linkMessage, setLinkMessage] = useState<string | null>(null)
  const [mergeMessage, setMergeMessage] = useState<string | null>(null)
  const [createMessage, setCreateMessage] = useState<string | null>(null)
  const [viewed, setViewed] = useState<number | null>(null)
  const [write, setWrite] = useState<PrWriteState>({ busy: null, message: null, notice: null })
  const [reviewers, setReviewers] = useState<PrReviewerCandidate[] | null>(null)
  const [reviewersBusy, setReviewersBusy] = useState(false)
  const [reviewersMessage, setReviewersMessage] = useState<string | null>(null)
  const [labels, setLabels] = useState<PrLabelCandidate[] | null>(null)
  const [labelsBusy, setLabelsBusy] = useState(false)
  const [labelsMessage, setLabelsMessage] = useState<string | null>(null)
  const [diff, setDiff] = useState<PrDiffView | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
  const [stack, setStack] = useState<PrStack | null>(null)
  const [stackChecked, setStackChecked] = useState(false)
  const [stackBusy, setStackBusy] = useState(false)
  const [stackMessage, setStackMessage] = useState<string | null>(null)

  const dirRef = useRef<string | null>(dir)
  // The newest request id issued or accepted; anything below it is stale.
  const watermark = useRef(0)
  const busyRef = useRef(false)
  const linkBusyRef = useRef(false)
  const latestLink = useRef(0)
  const mergeBusyRef = useRef(false)
  const latestMerge = useRef(0)
  const createBusyRef = useRef(false)
  const viewedRef = useRef<number | null>(null)
  const writeBusyRef = useRef<string | null>(null)
  const latestWrite = useRef(0)
  const pendingReviewerRemoval = useRef<{ number: number; reviewers: PrReviewer[] } | null>(null)
  const latestReviewers = useRef(0)
  const latestLabels = useRef(0)
  const latestDiff = useRef(0)
  const latestStack = useRef(0)

  const request = useCallback(
    (number: number | null = viewedRef.current) => {
      // A mutation in flight owns the next detail read (its own push), and a read
      // already in flight is the newest one; neither may be superseded by this.
      if (!client || !dir || busyRef.current || linkBusyRef.current || mergeBusyRef.current) return
      busyRef.current = true
      setBusy(true)
      watermark.current = client.prDetail(dir, number ?? undefined)
    },
    [client, dir]
  )

  useEffect(() => {
    dirRef.current = dir
    viewedRef.current = null
    setView(null)
    setBusy(false)
    busyRef.current = false
    setLinkBusy(false)
    linkBusyRef.current = false
    latestLink.current = 0
    setMergeBusy(false)
    mergeBusyRef.current = false
    latestMerge.current = 0
    setCreateBusy(false)
    createBusyRef.current = false
    setLinkMessage(null)
    setMergeMessage(null)
    setCreateMessage(null)
    setViewed(null)
    setWrite({ busy: null, message: null, notice: null })
    writeBusyRef.current = null
    latestWrite.current = 0
    setReviewers(null)
    setReviewersBusy(false)
    setReviewersMessage(null)
    latestReviewers.current = 0
    setLabels(null)
    setLabelsBusy(false)
    setLabelsMessage(null)
    latestLabels.current = 0
    setDiff(null)
    setDiffBusy(false)
    latestDiff.current = 0
    setStack(null)
    setStackChecked(false)
    setStackBusy(false)
    setStackMessage(null)
    latestStack.current = 0
  }, [dir, client])

  // A replaced client (reconnect) starts its own request counter, so the
  // watermark must start over with it or every reply would look stale.
  useEffect(() => {
    watermark.current = 0
  }, [client])

  useEffect(() => {
    if (!client || !dir || !active) return
    request()
  }, [client, dir, active, refreshSignal, request])

  useEffect(() => {
    if (!client) return
    const offDetail = client.subscribe('pr_detail', (msg) => {
      if (msg.dir !== dirRef.current) return
      if (msg.request < watermark.current) return
      watermark.current = msg.request
      busyRef.current = false
      setBusy(false)
      setView({
        gh: msg.gh,
        hasUpstream: msg.has_upstream,
        link: msg.link ?? null,
        detail: msg.detail ?? null,
        linked: msg.linked,
        hint: msg.hint ?? null,
        message: msg.message ?? null
      })
    })
    const offLinked = client.subscribe('pr_linked', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latestLink.current) return
      linkBusyRef.current = false
      setLinkBusy(false)
      if (!msg.ok) setLinkMessage(msg.message ?? 'Could not link the pull request.')
    })
    const offUnlinked = client.subscribe('pr_unlinked', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latestLink.current) return
      linkBusyRef.current = false
      setLinkBusy(false)
      if (!msg.ok) setLinkMessage(msg.message ?? 'Could not unlink the pull request.')
    })
    const offMerged = client.subscribe('pr_merged', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latestMerge.current) return
      mergeBusyRef.current = false
      setMergeBusy(false)
      if (!msg.ok) setMergeMessage(msg.message ?? 'The merge was refused.')
    })
    const offCreate = client.subscribe('pr_create', (msg) => {
      if (msg.dir !== dirRef.current) return
      createBusyRef.current = false
      setCreateBusy(false)
      if (msg.message) setCreateMessage(msg.message)
      if (msg.pr) request()
    })
    // Every write but merge answers with one shape; the request id is what the
    // control that issued it is holding.
    const offMutation = client.subscribe('pr_mutation', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latestWrite.current) return
      writeBusyRef.current = null
      setWrite({
        busy: null,
        message: msg.ok ? null : (msg.message ?? 'The pull request refused the write.'),
        notice: msg.ok ? (msg.message ?? null) : null
      })
      // A reviewer change in both directions is two requests; the second waits
      // for the first to be answered, because only one write may be in flight.
      const pending = pendingReviewerRemoval.current
      pendingReviewerRemoval.current = null
      if (msg.ok && msg.kind === 'reviewer_set' && pending && client && dirRef.current) {
        const key = `reviewers:${pending.number}`
        writeBusyRef.current = key
        setWrite({ busy: key, message: null, notice: null })
        latestWrite.current = client.prReviewerSet(
          dirRef.current,
          pending.number,
          pending.reviewers,
          false
        )
        watermark.current = latestWrite.current
      }
    })
    const offReviewers = client.subscribe('pr_reviewer_candidates', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latestReviewers.current) return
      latestReviewers.current = 0
      setReviewersBusy(false)
      setReviewers(msg.message == null ? msg.candidates : null)
      setReviewersMessage(msg.message ?? null)
    })
    const offLabels = client.subscribe('pr_label_candidates', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latestLabels.current) return
      latestLabels.current = 0
      setLabelsBusy(false)
      setLabels(msg.message == null ? msg.candidates : null)
      setLabelsMessage(msg.message ?? null)
    })
    const offStack = client.subscribe('pr_stack', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latestStack.current) return
      latestStack.current = 0
      setStackBusy(false)
      setStackChecked(true)
      setStack(msg.message == null ? (msg.stack ?? null) : null)
      setStackMessage(msg.message ?? null)
    })
    const offDiff = client.subscribe('pr_diff', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latestDiff.current) return
      latestDiff.current = 0
      setDiffBusy(false)
      setDiff({
        number: msg.number,
        patch: msg.message == null ? msg.patch : '',
        truncated: msg.truncated,
        message: msg.message ?? null
      })
    })
    return () => {
      offDetail()
      offLinked()
      offUnlinked()
      offMerged()
      offCreate()
      offMutation()
      offReviewers()
      offLabels()
      offDiff()
      offStack()
    }
  }, [client, request])

  // Issuing a mutation also advances the watermark and releases any read it
  // supersedes: that read's reply is dropped, so its busy flag must not stick.
  const link = useCallback(
    (number: number) => {
      if (!client || !dir || linkBusyRef.current) return
      linkBusyRef.current = true
      setLinkBusy(true)
      setLinkMessage(null)
      latestLink.current = client.prLink(dir, number)
      watermark.current = latestLink.current
      busyRef.current = false
      setBusy(false)
    },
    [client, dir]
  )

  const unlink = useCallback(() => {
    if (!client || !dir || linkBusyRef.current) return
    linkBusyRef.current = true
    setLinkBusy(true)
    setLinkMessage(null)
    latestLink.current = client.prUnlink(dir)
    watermark.current = latestLink.current
    busyRef.current = false
    setBusy(false)
    // Unlinking shows the branch's own pull request again, whichever number was
    // being browsed: the panel's subject is the workspace, not the last click.
    viewedRef.current = null
    setViewed(null)
  }, [client, dir])

  const create = useCallback(() => {
    if (!client || !dir || createBusyRef.current) return
    createBusyRef.current = true
    setCreateBusy(true)
    setCreateMessage(null)
    client.prCreate(dir)
  }, [client, dir])

  const merge = useCallback(
    (number: number, method: PrMergeMethod, expectedHeadSha: string) => {
      if (!client || !dir || mergeBusyRef.current) return
      mergeBusyRef.current = true
      setMergeBusy(true)
      setMergeMessage(null)
      latestMerge.current = client.prMerge(dir, number, method, expectedHeadSha)
      watermark.current = latestMerge.current
      busyRef.current = false
      setBusy(false)
    },
    [client, dir]
  )

  // The stack belongs to the subject that was read; a new subject drops what
  // was loaded for the old one, and its in-flight reply with it.
  const clearStack = useCallback(() => {
    latestStack.current = 0
    setStack(null)
    setStackChecked(false)
    setStackMessage(null)
  }, [])

  const show = useCallback(
    (number: number) => {
      viewedRef.current = number
      setViewed(number)
      clearStack()
      request(number)
    },
    [request, clearStack]
  )

  const showBranch = useCallback(() => {
    viewedRef.current = null
    setViewed(null)
    clearStack()
    request(null)
  }, [request, clearStack])

  // One write at a time, and issuing one clears the last failure: a stale
  // refusal must not sit beside a control that has since been retried.
  const writeNow = useCallback(
    (key: string, send: () => number) => {
      if (writeBusyRef.current !== null) return
      writeBusyRef.current = key
      setWrite({ busy: key, message: null, notice: null })
      latestWrite.current = send()
      watermark.current = latestWrite.current
      busyRef.current = false
      setBusy(false)
    },
    []
  )

  const edit = useCallback(
    (number: number, title: string | null, body: string | null) => {
      if (!client || !dir) return
      writeNow(`edit:${number}`, () => client.prEdit(dir, number, title, body))
    },
    [client, dir, writeNow]
  )

  const comment = useCallback(
    (number: number, body: string) => {
      if (!client || !dir) return
      writeNow(`comment:${number}`, () => client.prComment(dir, number, body))
    },
    [client, dir, writeNow]
  )

  const commentEdit = useCallback(
    (number: number, commentId: string, kind: PrCommentKind, body: string) => {
      if (!client || !dir) return
      writeNow(`comment-edit:${commentId}`, () => client.prCommentEdit(dir, number, commentId, kind, body))
    },
    [client, dir, writeNow]
  )

  const review = useCallback(
    (number: number, verdict: PrReviewVerdict, body: string, drafts: PrReviewDraft[]) => {
      if (!client || !dir) return
      writeNow(`review:${number}`, () => client.prReview(dir, number, verdict, body, drafts))
    },
    [client, dir, writeNow]
  )

  const threadReply = useCallback(
    (number: number, threadId: string, body: string) => {
      if (!client || !dir) return
      writeNow(`thread-reply:${threadId}`, () => client.prThreadReply(dir, number, threadId, body))
    },
    [client, dir, writeNow]
  )

  const threadResolve = useCallback(
    (number: number, threadId: string, resolved: boolean) => {
      if (!client || !dir) return
      writeNow(`thread-resolve:${threadId}`, () =>
        client.prThreadResolve(dir, number, threadId, resolved)
      )
    },
    [client, dir, writeNow]
  )

  const react = useCallback(
    (number: number, subjectId: string | null, content: PrReaction, reacted: boolean) => {
      if (!client || !dir) return
      writeNow(`reaction:${subjectId ?? 'pr'}:${content}`, () =>
        client.prReaction(dir, number, subjectId, content, reacted)
      )
    },
    [client, dir, writeNow]
  )

  const reviewerSet = useCallback(
    (number: number, list: PrReviewer[], requested: boolean) => {
      if (!client || !dir) return
      writeNow(`reviewers:${number}`, () => client.prReviewerSet(dir, number, list, requested))
    },
    [client, dir, writeNow]
  )

  const reviewerApply = useCallback(
    (number: number, added: PrReviewer[], removed: PrReviewer[]) => {
      if (!client || !dir) return
      if (added.length > 0) {
        pendingReviewerRemoval.current = removed.length > 0 ? { number, reviewers: removed } : null
        writeNow(`reviewers:${number}`, () => client.prReviewerSet(dir, number, added, true))
        return
      }
      if (removed.length > 0) {
        pendingReviewerRemoval.current = null
        writeNow(`reviewers:${number}`, () => client.prReviewerSet(dir, number, removed, false))
        return
      }
      pendingReviewerRemoval.current = null
    },
    [client, dir, writeNow]
  )

  const labelSet = useCallback(
    (number: number, list: string[], applied: boolean) => {
      if (!client || !dir) return
      writeNow(`labels:${number}`, () => client.prLabelSet(dir, number, list, applied))
    },
    [client, dir, writeNow]
  )

  const action = useCallback(
    (
      number: number,
      actionName: PrAction,
      opts: { mergeMethod?: PrMergeMethod; updateMethod?: PrUpdateMethod } = {}
    ) => {
      if (!client || !dir) return
      writeNow(`action:${actionName}`, () => client.prAction(dir, number, actionName, opts))
    },
    [client, dir, writeNow]
  )

  const loadReviewers = useCallback(
    (number: number) => {
      if (!client || !dir || reviewersBusy) return
      setReviewersBusy(true)
      setReviewersMessage(null)
      latestReviewers.current = client.prReviewers(dir, number)
    },
    [client, dir, reviewersBusy]
  )

  const loadLabels = useCallback(
    (number: number) => {
      if (!client || !dir || labelsBusy) return
      setLabelsBusy(true)
      setLabelsMessage(null)
      latestLabels.current = client.prLabels(dir, number)
    },
    [client, dir, labelsBusy]
  )

  const loadStack = useCallback(
    (number: number) => {
      if (!client || !dir || stackBusy) return
      setStackBusy(true)
      setStackMessage(null)
      latestStack.current = client.prStack(dir, number)
    },
    [client, dir, stackBusy]
  )

  const mergeStack = useCallback(
    (number: number, stackNumber: number, heads: PrStackHead[], method: PrMergeMethod) => {
      if (!client || !dir) return
      writeNow(`stack:${stackNumber}`, () =>
        client.prStackMerge(dir, number, stackNumber, heads, method)
      )
    },
    [client, dir, writeNow]
  )

  const loadDiff = useCallback(
    (number: number) => {
      if (!client || !dir || diffBusy) return
      setDiffBusy(true)
      latestDiff.current = client.prDiff(dir, number)
    },
    [client, dir, diffBusy]
  )

  return {
    view,
    busy,
    linkBusy,
    mergeBusy,
    createBusy,
    linkMessage,
    mergeMessage,
    createMessage,
    viewed,
    write,
    reviewers,
    reviewersBusy,
    reviewersMessage,
    labels,
    labelsBusy,
    labelsMessage,
    diff,
    diffBusy,
    stack,
    stackChecked,
    stackBusy,
    stackMessage,
    refresh: () => request(viewedRef.current),
    show,
    showBranch,
    link,
    unlink,
    create,
    merge,
    edit,
    comment,
    commentEdit,
    review,
    threadReply,
    threadResolve,
    react,
    reviewerSet,
    reviewerApply,
    labelSet,
    action,
    loadReviewers,
    loadLabels,
    loadDiff,
    loadStack,
    mergeStack
  }
}

// The browse list: one page at a time. Each reply replaces the page it answered,
// so filters are re-asked rather than merged, and Load more asks the same
// question with a bigger limit.
export function usePrList(
  client: HoustonClient | null,
  dir: string | null,
  active: boolean
): PrListController {
  const [items, setItems] = useState<PrListItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [state, setState] = useState<PrListState>('open')
  const [involvement, setInvolvement] = useState<PrListInvolvement>('all')
  const [query, setQuery] = useState('')

  const dirRef = useRef<string | null>(dir)
  const latest = useRef(0)
  const busyRef = useRef(false)
  const listRef = useRef<{ state: PrListState; involvement: PrListInvolvement; query: string; limit: number }>(
    { state: 'open', involvement: 'all', query: '', limit: PR_LIST_PAGE }
  )

  const ask = useCallback(
    (next: { state: PrListState; involvement: PrListInvolvement; query: string; limit: number }, more: boolean) => {
      if (!client || !dir || busyRef.current) return
      busyRef.current = true
      if (more) setLoadingMore(true)
      else setBusy(true)
      latest.current = client.prList(
        dir,
        next.state,
        next.involvement,
        next.query.trim().length === 0 ? null : next.query.trim(),
        next.limit
      )
    },
    [client, dir]
  )

  useEffect(() => {
    dirRef.current = dir
    setItems(null)
    setBusy(false)
    busyRef.current = false
    setTruncated(false)
    setMessage(null)
    listRef.current = { state: 'open', involvement: 'all', query: '', limit: PR_LIST_PAGE }
  }, [dir])

  useEffect(() => {
    if (!client) return
    const off = client.subscribe('pr_list', (msg) => {
      if (msg.dir !== dirRef.current || msg.request !== latest.current) return
      busyRef.current = false
      setBusy(false)
      setLoadingMore(false)
      if (msg.message != null) {
        setMessage(msg.message)
        setItems(null)
        return
      }
      setMessage(null)
      setItems(msg.items)
      setTruncated(msg.truncated)
    })
    return off
  }, [client])

  const load = useCallback(() => {
    const next = { ...listRef.current, limit: PR_LIST_PAGE }
    listRef.current = next
    ask(next, false)
  }, [ask])

  const loadMore = useCallback(() => {
    const nextLimit = Math.min(
      listRef.current.limit + PR_LIST_PAGE,
      Math.max(PR_LIST_PAGE_MAX, PR_LIST_PAGE * 4)
    )
    const next = { ...listRef.current, limit: nextLimit }
    listRef.current = next
    ask(next, true)
  }, [ask])

  const setFilters = useCallback(
    (next: { state?: PrListState; involvement?: PrListInvolvement; query?: string }) => {
      const merged = {
        state: next.state ?? listRef.current.state,
        involvement: next.involvement ?? listRef.current.involvement,
        query: next.query ?? listRef.current.query,
        limit: PR_LIST_PAGE
      }
      setState(merged.state)
      setInvolvement(merged.involvement)
      setQuery(merged.query)
      listRef.current = merged
      ask(merged, false)
    },
    [ask]
  )

  useEffect(() => {
    if (!client || !dir || !active) return
    const next = { ...listRef.current, limit: PR_LIST_PAGE }
    listRef.current = next
    ask(next, false)
    // The first load belongs to the tab becoming visible, not to every filter
    // keystroke: setFilters asks for its own change.
  }, [client, dir, active, ask])

  return {
    items,
    busy,
    loadingMore,
    truncated,
    message,
    state,
    involvement,
    query,
    setFilters,
    load,
    loadMore
  }
}
