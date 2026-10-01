// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshConnectModal, validateSshFields } from './SshConnectModal'
import { pickFile } from '../houston/bridge'
vi.mock('../houston/bridge', () => ({ pickFile: vi.fn() }))
function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
describe('SSH validation', () => {
  it.each(['', '-host', 'a b', 'a'.repeat(254)])('rejects Machine %j', (host) => {
    expect(validateSshFields(host, '', '22', '')).toContain(`Machine ${JSON.stringify(host)}`)
  })
  it.each(['-user', 'a b', 'a'.repeat(129)])('rejects Username %j', (user) => {
    expect(validateSshFields('host', user, '22', '')).toContain(`Username ${JSON.stringify(user)}`)
  })
  it.each(['', '0', '65536', '2.2'])('rejects Port %j', (port) => {
    expect(validateSshFields('host', '', port, '')).toContain(`Port ${JSON.stringify(port)}`)
  })
  it.each(['relative', '/a\n', '~/a\u007f'])('rejects Folder %j', (folder) => {
    expect(validateSshFields('host', '', '22', folder)).toContain(`Folder ${JSON.stringify(folder)}`)
  })
  it.each(['', '/srv/app', '~/projects/app'])('accepts Folder %j and optional Username', (folder) => {
    expect(validateSshFields('host:22', '', '65535', folder)).toBeNull()
  })
})
describe('SshConnectModal', () => {
  let container: HTMLDivElement
  let root: Root
  const connect = vi.fn()
  const close = vi.fn()
  beforeEach(() => {
    vi.resetAllMocks()
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    act(() => root.render(<SshConnectModal profiles={[]} onSaveProfile={vi.fn()} onDeleteProfile={vi.fn()} onConnect={connect} onClose={close} />))
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })
  const input = (id: string): HTMLInputElement => container.querySelector(`#ssh-${id}`)!
  const button = (text: string): HTMLButtonElement => Array.from(container.querySelectorAll('button')).find((element) => element.textContent === text)!
  function edit(id: string, value: string): void { act(() => setInput(input(id), value)) }
  it('focuses Machine, disables empty connect and removes obsolete controls', () => {
    expect(document.activeElement).toBe(input('machine')); expect(button('Connect').disabled).toBe(true)
    for (const text of ['Password', 'Recent', 'Save as profile', 'From ~/.ssh/config', 'Run on connect']) expect(container.textContent).not.toContain(text)
  })
  it('collapses Advanced by default and toggles it', () => {
    expect(container.querySelector('#ssh-port')).toBeNull(); expect(button('Advanced').getAttribute('aria-expanded')).toBe('false')
    act(() => button('Advanced').click()); expect(input('port').value).toBe('22')
    expect(button('Advanced').getAttribute('aria-controls')).toBe('ssh-advanced')
    act(() => button('Advanced').click()); expect(container.querySelector('#ssh-port')).toBeNull()
  })
  it('strips non-digits and bounds port input length', () => {
    act(() => button('Advanced').click()); edit('port', '12ab34567'); expect(input('port').value).toBe('12345')
  })
  it.each([['machine', '-host'], ['user', '-user'], ['folder', 'relative'], ['port', '65536']])('shows validation for %s and clears it on typing', async (id, value) => {
    edit('machine', 'host'); if (id === 'port') act(() => button('Advanced').click()); edit(id, value)
    await act(async () => button('Connect').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(JSON.stringify(value)); expect(connect).not.toHaveBeenCalled()
    edit(id, ''); expect(container.querySelector('[role="alert"]')).toBeNull()
  })
  it.each(['machine', 'user', 'folder', 'port'])('Enter in %s submits the session and directory', async (id) => {
    edit('machine', 'host'); edit('folder', '~/app'); if (id === 'port') act(() => button('Advanced').click())
    await act(async () => { input(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(connect).toHaveBeenCalledWith({ host: 'host', user: '', port: 22, auth: { kind: 'ssh_config' }, default_dir: '~/app' }); expect(close).toHaveBeenCalledOnce()
  })
  it('does not submit during IME composition', async () => {
    edit('machine', 'host')
    await act(async () => { input('machine').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })) })
    expect(connect).not.toHaveBeenCalled()
  })
  it.each([null, '/key'])('key picker result %j cancels or authenticates', async (path) => {
    vi.mocked(pickFile).mockResolvedValue(path); edit('machine', 'host'); act(() => button('Advanced').click())
    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    await act(async () => button('Connect').click()); expect(pickFile).toHaveBeenCalledWith('')
    if (path) expect(connect).toHaveBeenCalledWith(expect.objectContaining({ auth: { kind: 'identity_file', path, passphrase_profile: null } }))
    else { expect(connect).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled() }
  })
  it('uses the available SSH alias configuration with a chosen identity', async () => {
    vi.mocked(pickFile).mockResolvedValue('/key')
    act(() => root.render(<SshConnectModal profiles={[]} configHosts={[{ alias: 'edge', hostname: 'edge.internal', user: 'deploy', port: 2222, identity_file: null }]} onSaveProfile={vi.fn()} onDeleteProfile={vi.fn()} onConnect={connect} onClose={close} />))
    edit('machine', 'edge'); act(() => button('Advanced').click())
    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    await act(async () => button('Connect').click())
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'edge.internal', user: 'deploy', port: 2222 }))
  })
  it('ignores Escape while busy and re-enables Connect after picker cancellation', async () => {
    let resolve!: (path: string | null) => void
    vi.mocked(pickFile).mockReturnValue(new Promise((done) => { resolve = done }))
    edit('machine', 'host'); act(() => button('Advanced').click()); act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    act(() => button('Connect').click()); expect(button('Connecting…').disabled).toBe(true)
    act(() => container.querySelector('form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(close).not.toHaveBeenCalled(); await act(async () => resolve(null)); expect(button('Connect').disabled).toBe(false)
  })
  it('Escape cancels when idle', () => {
    act(() => input('machine').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(close).toHaveBeenCalledOnce()
  })
})
