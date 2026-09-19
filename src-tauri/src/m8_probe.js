;(() => {
  if (document.documentElement.dataset.trM8Probe) return
  document.documentElement.dataset.trM8Probe = 'running'

  const report = (step, payload) => {
    try {
      window.__TAURI_INTERNALS__.invoke('system_log_debug', {
        source: 'm8-probe',
        message: step,
        payload
      })
    } catch (err) {
      console.error('m8-probe: report failed', err)
    }
  }

  const rawInvoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__)

  const liveness = async (id) => {
    try {
      await rawInvoke('browser_reload', { id, bypassCache: false })
      return { live: true }
    } catch (err) {
      return { live: false, error: String(err) }
    }
  }

  const key = (el) => el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.tagName
  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }

  const freshInput = () =>
    [...document.querySelectorAll('input')].find(
      (i) => i.placeholder === 'enter a url to open a new tab'
    ) ?? null
  const gridSurfaces = () =>
    [...document.querySelectorAll('[data-browser-surface-id]')].map((el) =>
      el.getAttribute('data-browser-surface-id')
    )

  const typeInto = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const press = (target, init) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

  const STEP_KEY = 'tr-m8-probe-step'
  const URL = 'https://example.com/'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const waitForGrid = async () => {
    const launcherUp = () => !!document.querySelector('[data-testid="launcher-hint-footer"]')
    const gridUp = () =>
      !launcherUp() &&
      (document.body.textContent.includes('No terminals here') || !!document.querySelector('.pane'))
    for (let i = 0; i < 60; i++) {
      if (gridUp()) break
      if (launcherUp()) press(window, { key: 'Escape' })
      await sleep(500)
    }
    return gridUp()
  }

  const createAndNavigate = async (label) => {
    press(window, { key: 'b' })
    await sleep(1200)
    const input = freshInput()
    report(`${label}:created`, {
      freshAddressBar: !!input,
      nativeSurfaces: gridSurfaces()
    })
    if (!input) return null
    typeInto(input, URL)
    press(input, { key: 'Enter' })
    await sleep(5000)
    const surfaces = gridSurfaces()
    report(`${label}:navigated`, {
      url: URL,
      nativeSurfaces: surfaces,
      placeholderRect: rectOf(document.querySelector('[data-browser-surface-id]'))
    })
    return surfaces[0] ?? null
  }

  const persistedBrowserId = () => {
    let layoutKey = null
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('tr-layout:')) layoutKey = k
    }
    if (!layoutKey) return null
    const find = (n) => {
      if (!n || typeof n !== 'object') return null
      if (n.kind === 'browser') return n.id
      if (n.kind !== 'split') return null
      for (const c of n.children) {
        const found = find(c)
        if (found) return found
      }
      return null
    }
    try {
      return find(JSON.parse(localStorage.getItem(layoutKey)).tree)
    } catch (err) {
      report('layout-read-failed', { error: String(err) })
      return null
    }
  }

  const pageErrors = []
  window.addEventListener('error', (e) =>
    pageErrors.push({ message: String(e.message), source: String(e.filename), line: e.lineno })
  )
  window.addEventListener('unhandledrejection', (e) =>
    pageErrors.push({ unhandledRejection: String(e.reason) })
  )

  const windowLabels = async () => {
    for (const cmd of ['plugin:window|get_all_windows', 'plugin:webview|get_all_webviews']) {
      try {
        const res = await rawInvoke(cmd)
        if (Array.isArray(res)) return { cmd, labels: res.map((w) => (typeof w === 'string' ? w : w.label)) }
      } catch {
      }
    }
    return null
  }

  const run = async () => {
    if (localStorage.getItem(STEP_KEY) === 'reloaded') {
      localStorage.removeItem(STEP_KEY)
      await sleep(8000)
      const id = persistedBrowserId()
      const rendered = gridSurfaces()
      const live = id ? await liveness(id) : { live: false, error: 'no browser leaf in the persisted layout' }
      const banner = document.querySelector('[data-testid="browser-pane-mount-recovery"]')
      report('restored-child', {
        mountRecoveryBanner: !!banner,
        mountDiagnosis: banner
          ? 'the mount WAS requested and failed (recovery banner is up)'
          : 'no recovery banner: the mount was never requested, or failed without reporting',
        idFromLayout: id,
        renderedPlaceholders: rendered,
        rustSaysLive: live,
        urlBarValue: ([...document.querySelectorAll('input')].find((i) => (i.value || '').includes('example.com')) || {}).value ?? null,
        verdict:
          rendered.length > 0 && live.live
            ? 'REMOUNTED — the restored pane has its native child back'
            : 'NO CHILD — the leaf and its url came back, the native child did not'
      })
      report('done', { leg: 'reload' })
      return
    }

    report('start', {
      note: 'leg 1: create → navigate → resize → close (child destroyed?); leg 2: reload (child restored?)',
      channel: location.href
    })
    if (!(await waitForGrid())) return report('abort', { reason: 'no workspace grid appeared' })

    const id = await createAndNavigate('leg1')
    if (!id) return report('abort', { reason: 'no native surface after navigating the new pane' })

    const rectBefore = rectOf(document.querySelector('[data-browser-surface-id]'))
    press(window, { key: 'B', ctrlKey: true, shiftKey: true })
    await sleep(2500)
    const rectAfter = rectOf(document.querySelector('[data-browser-surface-id]'))
    report('resized', {
      rectBefore,
      rectAfter,
      changed: JSON.stringify(rectBefore) !== JSON.stringify(rectAfter)
    })
    press(window, { key: 'B', ctrlKey: true, shiftKey: true })
    await sleep(1200)

    const pane = document.querySelector('.pane.browser')
    const closeBtn = pane ? pane.querySelector('button[title="Close"]') : null
    report('closing', { paneFound: !!pane, closeButtonFound: !!closeBtn, surfaceId: id })
    if (!pane || !closeBtn) return report('abort', { reason: 'no browser pane / no scoped Close button' })

    const before = await liveness(id)
    report('liveness-before-close', before)

    const attempts = []
    const stillThere = () => !!document.querySelector('.pane.browser')
    closeBtn.click()
    await sleep(1500)
    attempts.push({ how: 'el.click()', paneStillRendered: stillThere() })
    if (stillThere()) {
      closeBtn.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      )
      await sleep(1500)
      attempts.push({ how: 'dispatch MouseEvent', paneStillRendered: stillThere() })
    }
    if (stillThere()) {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        closeBtn.dispatchEvent(
          type.startsWith('pointer')
            ? new PointerEvent(type, { bubbles: true, cancelable: true })
            : new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
        )
      }
      await sleep(1500)
      attempts.push({ how: 'full pointer+mouse sequence', paneStillRendered: stillThere() })
    }
    report('close-attempts', { attempts, pageErrors })
    const closeTook = {
      paneStillRendered: !!document.querySelector('.pane.browser'),
      panesLeft: document.querySelectorAll('.pane').length,
      browserLeafInLayout: persistedBrowserId(),
      buttonTitle: closeBtn.getAttribute('title'),
      buttonDisabled: closeBtn.disabled === true,
      pageErrors
    }
    report('close-took-effect', closeTook)
    const after = await liveness(id)
    let destroyControl
    try {
      await rawInvoke('browser_destroy', { id })
      destroyControl = { verdict: 'destroy succeeded — a child was still registered' }
    } catch (err) {
      destroyControl = { verdict: 'destroy refused — the registry has no such child', error: String(err) }
    }
    report('closed', {
      nativeSurfaces: gridSurfaces(),
      livenessBefore: before,
      livenessAfterClose: after,
      destroyControl,
      closeTook,
      verdict:
        !before.live
          ? 'INCONCLUSIVE — the child was not live before the close'
          : closeTook.paneStillRendered || closeTook.browserLeafInLayout === id
            ? 'INCONCLUSIVE — the close did not take effect (pane still present), so nothing was destroyed to observe'
          : after.live
            ? 'LEAKED — the registry still holds the child after the pane was closed'
            : 'DESTROYED — the registry held this child before the close and does not after it'
    })

    const idD = await createAndNavigate('leg3')
    if (!idD) {
      report('abort', { reason: 'leg 3: no native surface to detach' })
    } else {
      const before = await windowLabels()
      let detachErr = null
      try {
        await rawInvoke('browser_detach', { id: idD })
      } catch (err) {
        detachErr = String(err)
      }
      await sleep(2500)
      const during = await windowLabels()
      const newLabels =
        before && during ? during.labels.filter((l) => !before.labels.includes(l)) : null
      report('leg3:detached', {
        id: idD,
        detachErr,
        enumerateVia: during ? during.cmd : null,
        before: before ? before.labels : null,
        during: during ? during.labels : null,
        windowOpened: newLabels
      })

      const paneD = document.querySelector('.pane.browser')
      const closeD = paneD ? paneD.querySelector('button[title="Close"]') : null
      if (closeD) closeD.click()
      await sleep(3000)
      const afterClose = await windowLabels()
      report('leg3:destroyed-while-detached', {
        closeButtonFound: !!closeD,
        after: afterClose ? afterClose.labels : null,
        verdict:
          !newLabels || newLabels.length === 0
            ? 'INCONCLUSIVE — no detached window was observed to open'
            : !afterClose
              ? 'INCONCLUSIVE — window enumeration unavailable after the close'
              : newLabels.every((l) => !afterClose.labels.includes(l))
                ? 'WINDOW CLOSED — destroying the detached pane took its window with it'
                : 'WINDOW LEAKED — the detached window outlived the pane that owned it'
      })
    }

    const id2 = await createAndNavigate('leg2')
    if (!id2) return report('abort', { reason: 'leg 2: no native surface to reload with' })
    localStorage.setItem(STEP_KEY, 'reloaded')
    report('reloading', { id2 })
    location.reload()
  }

  run().catch((err) => report('threw', { error: String(err), stack: String(err && err.stack) }))
})()
