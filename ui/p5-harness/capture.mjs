function captureStage(page, ignoreArr) {
  return page.evaluate((ignore) => {
    const IG = new Set(ignore)
    const stage = document.querySelector('[data-stage]')
    if (!stage) return null
    const root = stage.firstElementChild
    if (!root) return null
    const origin = stage.getBoundingClientRect()
    const r2 = (n) => Math.round(n * 100) / 100
    // CodeMirror's cursor/selection overlays: positioned by CM's own async
    // measure phase, which nothing the harness awaits can pin, so their
    // presence flakes even a new-vs-new capture. Skip the whole subtree.
    const SKIP_SUBTREE = (el) => el.classList && el.classList.contains('cm-layer')
    const serialize = (el) => {
      const rect = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const style = {}
      for (let i = 0; i < cs.length; i++) {
        const prop = cs[i]
        const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        if (IG.has(camel) || prop.startsWith('--') || prop.startsWith('-webkit')) continue
        style[prop] = cs.getPropertyValue(prop)
      }
      return {
        tag: el.tagName,
        box: [r2(rect.x - origin.x), r2(rect.y - origin.y), r2(rect.width), r2(rect.height)],
        style,
        children: [...el.children].filter((c) => !SKIP_SUBTREE(c)).map(serialize)
      }
    }
    return serialize(root)
  }, ignoreArr)
}

export { captureStage }
