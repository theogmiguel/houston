// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SshConnectModal, type SshConnectParams } from './SshConnectModal'
import type { SshProfile } from '../houston/client'

function profile(overrides: Partial<SshProfile> = {}): SshProfile {
  return {
    name: 'prod-box',
    host: 'prod.example.com',
    port: 22,
    user: 'deploy',
    auth: { kind: 'agent' },
    default_dir: null,
    startup_cmd: null,
    last_used_at: null,
    has_credential: false,
    ...overrides
  }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SshConnectModal — profile wishes, duplicate, recents (v45)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(
    profiles: SshProfile[],
    handlers: {
      onConnect?: (p: SshConnectParams) => void
      onSaveProfile?: (p: SshProfile) => void
    } = {}
  ): void {
    act(() => {
      root.render(
        <SshConnectModal
          profiles={profiles}
          onConnect={handlers.onConnect ?? (() => {})}
          onSaveProfile={handlers.onSaveProfile ?? (() => {})}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })
  }

  const hostInput = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('input[placeholder="example.com"]')!
  const dirInput = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('#ssh-default-dir')!
  const cmdInput = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('#ssh-startup-cmd')!
  const findButton = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))

  it('saves the post-connect fields with the profile', () => {
    const saved: SshProfile[] = []
    render([], { onSaveProfile: (p) => saved.push(p) })

    act(() => {
      setInputValue(hostInput(), 'box.example.com')
      setInputValue(container.querySelector<HTMLInputElement>('input[placeholder="user"]')!, 'dev')
      setInputValue(dirInput(), '/srv/app')
      setInputValue(cmdInput(), 'tmux attach')
    })
    const saveAs = container.querySelector<HTMLButtonElement>('[data-testid="ssh-save-as-profile"]')
    act(() => {
      saveAs?.click()
    })
    const nameField = container.querySelector<HTMLInputElement>('input[placeholder*="rofile"]')
    if (nameField) act(() => setInputValue(nameField, 'boxy'))

    act(() => {
      findButton('Save')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(saved).toHaveLength(1)
    expect(saved[0].default_dir).toBe('/srv/app')
    expect(saved[0].startup_cmd).toBe('tmux attach')
    expect(saved[0].last_used_at).toBeNull()
  })

  it('loads a profile’s wishes into the form when it is applied', () => {
    render([profile({ default_dir: '/srv/edge', startup_cmd: 'tmux attach' })])
    act(() => {
      findButton('prod-box')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(dirInput().value).toBe('/srv/edge')
    expect(cmdInput().value).toBe('tmux attach')
  })

  it('names the profile it connected with, so the daemon can apply and stamp it', () => {
    const sent: SshConnectParams[] = []
    render([profile({ default_dir: '/srv/edge' })], { onConnect: (p) => sent.push(p) })

    act(() => {
      findButton('prod-box')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      findButton('Connect')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].profile).toBe('prod-box')
    expect(Object.keys(sent[0])).not.toContain('startup_cmd')
  })

  it('stops naming the profile once a connection field is edited by hand', () => {
    const sent: SshConnectParams[] = []
    render([profile({ startup_cmd: 'deploy.sh' })], { onConnect: (p) => sent.push(p) })

    act(() => {
      findButton('prod-box')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      setInputValue(hostInput(), 'someone-elses-box.example.com')
    })
    act(() => {
      findButton('Connect')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].host).toBe('someone-elses-box.example.com')
    expect(sent[0].profile).toBeUndefined()
  })

  it('still names the profile when only the post-connect fields are edited', () => {
    const sent: SshConnectParams[] = []
    render([profile()], { onConnect: (p) => sent.push(p) })

    act(() => {
      findButton('prod-box')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      setInputValue(dirInput(), '/srv/other')
    })
    act(() => {
      findButton('Connect')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(sent[0].profile).toBe('prod-box')
  })

  it('duplicates into the form under a free name instead of saving over the original', () => {
    const saved: SshProfile[] = []
    render([profile(), profile({ name: 'prod-box copy' })], {
      onSaveProfile: (p) => saved.push(p)
    })

    const dup = container.querySelector<HTMLButtonElement>('[aria-label="Duplicate profile prod-box"]')
    expect(dup).not.toBeNull()
    act(() => {
      dup?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(saved).toHaveLength(0)
    const nameField = container.querySelector<HTMLInputElement>('input[placeholder*="rofile"]')
    expect(nameField?.value).toBe('prod-box copy 2')
    expect(hostInput().value).toBe('prod.example.com')
  })

  it('does not attribute a connect to the profile a duplicate was copied from', () => {
    const sent: SshConnectParams[] = []
    render([profile({ startup_cmd: 'deploy.sh' })], { onConnect: (p) => sent.push(p) })

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Duplicate profile prod-box"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      findButton('Connect')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(sent[0].profile).toBeUndefined()
  })

  it('shows nothing at all until something has been connected', () => {
    render([profile(), profile({ name: 'other' })])
    expect(container.querySelector('[data-testid="ssh-recent"]')).toBeNull()
    expect(container.textContent).not.toContain('Recent')
  })

  it('lists used profiles newest first, capped', () => {
    render([
      profile({ name: 'a', last_used_at: 100 }),
      profile({ name: 'b', last_used_at: 300 }),
      profile({ name: 'c', last_used_at: 200 }),
      profile({ name: 'd', last_used_at: 500 }),
      profile({ name: 'e', last_used_at: 400 }),
      profile({ name: 'never-used' })
    ])
    const chips = Array.from(
      container.querySelectorAll('[data-testid="ssh-recent"] button')
    ).map((b) => b.textContent ?? '')

    expect(chips).toHaveLength(4)
    expect(chips[0]).toContain('d')
    expect(chips[1]).toContain('e')
    expect(chips.join(' ')).not.toContain('never-used')
  })

  it('connects straight from a chip, naming that profile', () => {
    const sent: SshConnectParams[] = []
    render([profile({ name: 'edge', host: 'edge.example.com', last_used_at: 10 })], {
      onConnect: (p) => sent.push(p)
    })

    act(() => {
      setInputValue(hostInput(), 'typed-but-unused.example.com')
    })
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="ssh-recent"] button')
    act(() => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].host).toBe('edge.example.com')
    expect(sent[0].profile).toBe('edge')
  })
})

describe('SshConnectModal — password auth and ssh_config (v45)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const findButton = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
  const passwordInput = (): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>('#ssh-password')

  function render(profiles: SshProfile[], handlers: Record<string, unknown> = {}): void {
    act(() => {
      root.render(
        <SshConnectModal
          profiles={profiles}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
          {...handlers}
        />
      )
    })
  }

  it('offers password auth, and its field is a password field', () => {
    render([])
    expect(passwordInput()).toBeNull()
    act(() => {
      findButton('Password')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(passwordInput()?.type).toBe('password')
  })

  it('sends the password by its own path, never inside the saved profile', () => {
    const saved: SshProfile[] = []
    const creds: Array<[string, string]> = []
    render([], {
      onSaveProfile: (p: SshProfile) => saved.push(p),
      onSetCredential: (profile: string, password: string) => creds.push([profile, password])
    })

    act(() => {
      findButton('Password')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>('input[placeholder="example.com"]')!,
        'box.example.com'
      )
      setInputValue(container.querySelector<HTMLInputElement>('input[placeholder="user"]')!, 'dev')
      setInputValue(passwordInput()!, 'hunter2')
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="ssh-save-as-profile"]')?.click()
    })
    const nameField = container.querySelector<HTMLInputElement>('input[placeholder*="rofile"]')
    if (nameField) act(() => setInputValue(nameField, 'boxy'))

    act(() => {
      findButton('Save')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(creds).toEqual([['boxy', 'hunter2']])
    expect(saved).toHaveLength(1)
    expect(saved[0].auth).toEqual({ kind: 'password', profile: 'boxy' })
    expect(JSON.stringify(saved[0])).not.toContain('hunter2')
  })

  it('says where a stored password lives, and offers a way to remove it', () => {
    const cleared: string[] = []
    render(
      [
        profile({
          name: 'prod-box',
          has_credential: true,
          auth: { kind: 'password', profile: 'prod-box' }
        })
      ],
      { onClearCredential: (p: string) => cleared.push(p) }
    )
    act(() => {
      findButton('prod-box')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(passwordInput()).not.toBeNull()

    expect(container.textContent).toContain('keychain')
    act(() => {
      findButton('Forget')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(cleared).toEqual(['prod-box'])
  })

  it('never carries a typed password across a profile switch', () => {
    const creds: Array<[string, string]> = []
    render([profile({ name: 'a' }), profile({ name: 'b' })], {
      onSetCredential: (profile: string, password: string) => creds.push([profile, password])
    })
    act(() => {
      findButton('Password')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      setInputValue(passwordInput()!, 'typed-for-nobody')
    })
    act(() => {
      findButton('b')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      findButton('Password')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(passwordInput()?.value).toBe('')
    expect(creds).toEqual([])
  })

  it('explains what ssh_config does and does not read', () => {
    render([])
    act(() => {
      findButton('ssh config')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('ProxyJump')
    expect(container.textContent).toContain('IdentityFile')
  })

  it('imports a config host into the form without saving it', () => {
    const saved: SshProfile[] = []
    render([], {
      onSaveProfile: (p: SshProfile) => saved.push(p),
      configHosts: [
        { alias: 'edge', hostname: 'edge-01.internal', user: 'deploy', port: 2222, identity_file: null }
      ]
    })

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="ssh-config-hosts"] button')
    expect(chip).not.toBeNull()
    act(() => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(saved).toHaveLength(0)
    expect(container.querySelector<HTMLInputElement>('input[placeholder="example.com"]')?.value).toBe(
      'edge'
    )
    expect(container.textContent).toContain('ProxyJump')
  })

  it('asks for the config hosts when it opens, not before', () => {
    let calls = 0
    render([], { onLoadConfigHosts: () => (calls += 1) })
    expect(calls).toBe(1)
  })
})

describe('SshConnectModal — keyring unreachable (v45)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('says the password was not lost when the keychain is unreachable', () => {
    act(() => {
      root.render(
        <SshConnectModal
          profiles={[]}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
          keyringError="no Secret Service provider on the session bus"
        />
      )
    })
    const passwordButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Password'
    )
    act(() => {
      passwordButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('unreachable')
    expect(container.textContent).toContain('has not been lost')
    expect(container.textContent).toContain('Secret Service')
  })
})
