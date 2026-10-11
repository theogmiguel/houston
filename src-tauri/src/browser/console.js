(() => {
  if (window.__trConsoleInstalled) return
  Object.defineProperty(window, '__trConsoleInstalled', { value: true })
  // Match the host ring so logs captured before handler registration stay bounded.
  const pending = []
  const flush = () => {
    try {
      const handler = window.webkit?.messageHandlers?.trConsole
      if (!handler) return
      while (pending.length) {
        handler.postMessage(pending[0])
        pending.shift()
      }
    } catch (_) {}
  }
  Object.defineProperty(window, '__trConsoleFlush', { value: flush })
  const send = (level, args) => {
    try {
      const text = args.map(value => {
        try {
          if (typeof value === 'string') return value
          if (value && typeof value.stack === 'string') return value.stack
          const encoded = JSON.stringify(value)
          return encoded === undefined ? String(value) : encoded
        }
        catch (_) { return String(value) }
      }).join(' ').slice(0, 4096)
      if (pending.length === 256) pending.shift()
      pending.push(JSON.stringify({ level, text }))
      flush()
    } catch (_) {}
  }
  const levels = { log: 'log', debug: 'debug', info: 'info', warn: 'warn', error: 'error', assert: 'error', trace: 'debug' }
  for (const method of Object.getOwnPropertyNames(console)) {
    if (typeof console[method] !== 'function') continue
    const original = console[method].bind(console)
    console[method] = (...args) => {
      if (method !== 'assert' || !args[0]) {
        const content = method === 'assert' ? args.slice(1) : args
        send(levels[method] || 'info', levels[method] ? content : [`console.${method}`, ...content])
      }
      return original(...args)
    }
  }
  window.addEventListener('error', event => send('error', [event.message, event.filename, event.lineno]))
  window.addEventListener('unhandledrejection', event => send('error', ['Unhandled rejection', event.reason]))
})()
