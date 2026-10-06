export function unreachableHost(url: string): string {
  try {
    const parsed = new URL(url)
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    return `${parsed.hostname}:${port}`
  } catch {
    return url
  }
}

export function unreachableMessage(url: string, error: string): string {
  try {
    const parsed = new URL(url)
    const refused = /ERR_CONNECTION_REFUSED|connection refused|actively refused/i.test(error)
    if (refused && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.replace(/^\[|\]$/g, ''))) {
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
      return `Nothing is listening on port ${port}. Start the server, then retry.`
    }
  } catch {
    return error
  }
  return error
}
