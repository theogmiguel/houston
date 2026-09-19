;(() => {
  const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

  const report = (message, payload) => {
    try {
      window.__TAURI_INTERNALS__.invoke('system_log_debug', {
        source: 'wasm-csp-probe',
        message,
        payload
      })
    } catch (err) {
      console.error('wasm-csp-probe: report failed', err)
    }
  }

  WebAssembly.instantiate(EMPTY_WASM, {})
    .then((result) => {
      report('csp-wasm-probe: instantiate=ok', {
        ok: true,
        hasInstance: Boolean(result && result.instance)
      })
    })
    .catch((err) => {
      const name = (err && err.name) || 'Error'
      const detail = (err && err.message) || String(err)
      report(`csp-wasm-probe: instantiate=blocked ${name}: ${detail}`, {
        ok: false,
        name,
        message: detail
      })
    })
})()
