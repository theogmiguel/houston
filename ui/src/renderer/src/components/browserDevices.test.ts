import { describe, expect, it } from 'vitest'
import { browserSecurity, fitBrowserDevice } from './browserDevices'

describe('browser device fit and connection labels', () => {
  it('fits both dimensions and never enlarges the device', () => {
    expect(fitBrowserDevice('phone', 212, 460)).toBeCloseTo(0.54, 2)
    expect(fitBrowserDevice('tablet', 300, 430)).toBeCloseTo(0.3644, 3)
    expect(fitBrowserDevice('phone', 1000, 1000)).toBe(1)
    expect(fitBrowserDevice('phone', 0, 0)).toBe(0)
    expect(fitBrowserDevice('desktop', 400, 300)).toBe(1)
  })
  it.each(['http://localhost:3000', 'http://preview.localhost', 'http://127.0.0.1', 'http://[::1]'])('labels loopback %s local', (url) => {
    expect(browserSecurity(url)).toBe('local')
  })
  it('labels connection security without trusting lookalike domains', () => {
    expect(browserSecurity('https://example.com')).toBe('secure')
    expect(browserSecurity('http://localhost.evil.test')).toBe('not secure')
    expect(browserSecurity('http://127.evil.test')).toBe('not secure')
    expect(browserSecurity('http://example.com')).toBe('not secure')
    expect(browserSecurity(null)).toBe('not secure')
  })
})
