import { describe, expect, it } from 'vitest'
import { unreachableHost, unreachableMessage } from './browserUnreachable'

describe('browser unreachable copy', () => {
  it('uses the refused loopback port copy', () => {
    expect(unreachableMessage('http://localhost:8080/', 'ERR_CONNECTION_REFUSED')).toBe(
      'Nothing is listening on port 8080. Start the server, then retry.'
    )
  })

  it('keeps the engine message for non-loopback failures', () => {
    expect(unreachableMessage('https://example.test/', 'DNS lookup failed')).toBe('DNS lookup failed')
  })

  it('labels the host and port from the attempted URL', () => {
    expect(unreachableHost('http://localhost:8080/path')).toBe('localhost:8080')
    expect(unreachableHost('https://example.test/')).toBe('example.test:443')
  })
})
