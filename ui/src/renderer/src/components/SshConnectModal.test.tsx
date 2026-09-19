// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshProfile } from '../houston/client'
import { computeSshFormState, SshConnectModal } from './SshConnectModal'

window.houston = { pickFile: vi.fn() } as unknown as Window['houston']

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

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

function formInput(
  overrides: Partial<Parameters<typeof computeSshFormState>[0]> = {}
): Parameters<typeof computeSshFormState>[0] {
  return {
    host: 'prod.example.com',
    user: 'deploy',
    authKind: 'agent',
    identityPath: '',
    touched: { host: false, user: false, identity: false },
    editingProfileName: null,
    appliedProfile: null,
    saveAsProfile: false,
    profileName: '',
    profiles: [],
    ...overrides
  }
}

describe('computeSshFormState', () => {
  it('identity_file with an empty path blocks connect and reports missing once touched', () => {
    const blank = computeSshFormState(formInput({ authKind: 'identity_file', identityPath: '' }))
    expect(blank.canConnect).toBe(false)
    expect(blank.identityError).toBeNull()

    const touched = computeSshFormState(
      formInput({
        authKind: 'identity_file',
        identityPath: '',
        touched: { host: false, user: false, identity: true }
      })
    )
    expect(touched.canConnect).toBe(false)
    expect(touched.identityError).toBe('An identity file is required for this auth method')
  })

  it('identity_file with a path present allows connect and clears the error', () => {
    const state = computeSshFormState(
      formInput({
        authKind: 'identity_file',
        identityPath: '~/.ssh/id_ed25519',
        touched: { host: false, user: false, identity: true }
      })
    )
    expect(state.canConnect).toBe(true)
    expect(state.identityError).toBeNull()
  })

  it.each([
    ['agent', ''],
    ['password', ''],
    ['ssh_config', '']
  ] as const)('%s auth never requires an identity path for canConnect', (authKind, identityPath) => {
    const state = computeSshFormState(formInput({ authKind, identityPath }))
    expect(state.canConnect).toBe(true)
  })

  it('canConnect is false when host or user is blank, regardless of auth kind', () => {
    expect(computeSshFormState(formInput({ host: '' })).canConnect).toBe(false)
    expect(computeSshFormState(formInput({ user: '' })).canConnect).toBe(false)
    expect(computeSshFormState(formInput({ host: '   ' })).canConnect).toBe(false)
  })

  it('canSaveProfile is true while editing an existing profile, even with no typed name', () => {
    const state = computeSshFormState(
      formInput({ editingProfileName: 'prod-box', saveAsProfile: false, profileName: '' })
    )
    expect(state.canSaveProfile).toBe(true)
  })

  it('canSaveProfile is false for a new profile with an empty name', () => {
    const notChecked = computeSshFormState(formInput({ saveAsProfile: false, profileName: '' }))
    expect(notChecked.canSaveProfile).toBe(false)

    const checkedButBlank = computeSshFormState(formInput({ saveAsProfile: true, profileName: '   ' }))
    expect(checkedButBlank.canSaveProfile).toBe(false)
  })

  it('canSaveProfile is true for a new profile once it has a name and the form is valid', () => {
    const state = computeSshFormState(formInput({ saveAsProfile: true, profileName: 'staging' }))
    expect(state.canSaveProfile).toBe(true)
  })

  it('canSaveProfile stays false for a named new profile if the connection fields are invalid', () => {
    const state = computeSshFormState(
      formInput({ host: '', saveAsProfile: true, profileName: 'staging' })
    )
    expect(state.canSaveProfile).toBe(false)
  })

  it('hostError only fires once the host field has been touched and is blank', () => {
    expect(computeSshFormState(formInput({ host: '' })).hostError).toBeNull()
    expect(
      computeSshFormState(formInput({ host: '', touched: { host: true, user: false, identity: false } }))
        .hostError
    ).toBe('Host is required')
    expect(
      computeSshFormState(
        formInput({ host: 'x', touched: { host: true, user: false, identity: false } })
      ).hostError
    ).toBeNull()
  })

  it('userError only fires once the user field has been touched and is blank', () => {
    expect(computeSshFormState(formInput({ user: '' })).userError).toBeNull()
    expect(
      computeSshFormState(formInput({ user: '', touched: { host: false, user: true, identity: false } }))
        .userError
    ).toBe('Username is required')
    expect(
      computeSshFormState(
        formInput({ user: 'x', touched: { host: false, user: true, identity: false } })
      ).userError
    ).toBeNull()
  })

  it('identityError only fires once the identity field has been touched, for identity_file auth', () => {
    expect(
      computeSshFormState(formInput({ authKind: 'identity_file', identityPath: '' })).identityError
    ).toBeNull()
    expect(
      computeSshFormState(
        formInput({
          authKind: 'password',
          identityPath: '',
          touched: { host: false, user: false, identity: true }
        })
      ).identityError
    ).toBeNull()
  })
})

describe('SshConnectModal (Q18: edit-in-place, save-without-connect, field validation)', () => {
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

  function hostInput(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>('input[placeholder="example.com"]')!
  }
  function userInput(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>('input[placeholder="user"]')!
  }
  function findButton(text: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
  }


  it('entering edit mode prefills the form, and Cancel restores the previous state', () => {
    const p = profile()
    act(() => {
      root.render(
        <SshConnectModal
          profiles={[p]}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })

    act(() => {
      setInputValue(hostInput(), 'scratch.example.com')
      setInputValue(userInput(), 'scratchuser')
    })
    expect(hostInput().value).toBe('scratch.example.com')

    const editButton = container.querySelector<HTMLButtonElement>(`[aria-label="Edit profile ${p.name}"]`)
    expect(editButton).not.toBeNull()
    act(() => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(hostInput().value).toBe(p.host)
    expect(userInput().value).toBe(p.user)
    expect(container.textContent).toContain(`Editing`)
    expect(container.textContent).toContain(p.name)
    expect(container.querySelector(`[aria-label="Edit profile ${p.name}"]`)).toBeNull()

    const cancelBanner = findButton('Cancel')
    act(() => {
      cancelBanner?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(hostInput().value).toBe('scratch.example.com')
    expect(userInput().value).toBe('scratchuser')
    expect(container.querySelector(`[aria-label="Edit profile ${p.name}"]`)).not.toBeNull()
  })


  it('"Save without connecting" calls the save path and never the connect path', () => {
    const onConnect = vi.fn()
    const onSaveProfile = vi.fn()
    const p = profile()
    act(() => {
      root.render(
        <SshConnectModal
          profiles={[p]}
          onConnect={onConnect}
          onSaveProfile={onSaveProfile}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })

    act(() => {
      container.querySelector<HTMLButtonElement>(`[aria-label="Edit profile ${p.name}"]`)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    act(() => {
      setInputValue(userInput(), 'newuser')
    })

    const saveButton = findButton('Save without connecting')
    expect(saveButton?.disabled).toBe(false)
    act(() => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSaveProfile).toHaveBeenCalledTimes(1)
    expect(onSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: p.name, user: 'newuser' }))
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('disables "Save without connecting" when there is nothing to name the profile', () => {
    act(() => {
      root.render(
        <SshConnectModal
          profiles={[]}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })
    act(() => {
      setInputValue(hostInput(), 'h.example.com')
      setInputValue(userInput(), 'u')
    })
    expect(findButton('Save without connecting')?.disabled).toBe(true)
  })


  it('shows each required message only after its own field is blurred empty, flipping aria-invalid', () => {
    act(() => {
      root.render(
        <SshConnectModal
          profiles={[]}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })

    expect(container.textContent).not.toContain('Host is required')
    expect(container.textContent).not.toContain('Username is required')
    expect(hostInput().getAttribute('aria-invalid')).toBeNull()

    act(() => {
      hostInput().focus()
      hostInput().blur()
    })
    expect(container.textContent).toContain('Host is required')
    expect(hostInput().getAttribute('aria-invalid')).toBe('true')
    expect(hostInput().getAttribute('aria-describedby')).toBe('ssh-host-error')
    expect(container.textContent).not.toContain('Username is required')
    expect(userInput().getAttribute('aria-invalid')).toBeNull()

    act(() => {
      userInput().focus()
      userInput().blur()
    })
    expect(container.textContent).toContain('Username is required')
    expect(userInput().getAttribute('aria-invalid')).toBe('true')

    act(() => {
      setInputValue(hostInput(), 'h.example.com')
    })
    expect(container.textContent).not.toContain('Host is required')
    expect(hostInput().getAttribute('aria-invalid')).toBeNull()
    expect(container.textContent).toContain('Username is required')
  })

  it('requires an identity file only for identity_file auth, after its field is blurred empty', () => {
    act(() => {
      root.render(
        <SshConnectModal
          profiles={[]}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })

    const identityToggle = findButton('Identity file')
    act(() => {
      identityToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const identityInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="~/.ssh/id_ed25519"]'
    )!
    expect(container.textContent).not.toContain('An identity file is required for this auth method')

    act(() => {
      identityInput.focus()
      identityInput.blur()
    })
    expect(container.textContent).toContain('An identity file is required for this auth method')
    expect(identityInput.getAttribute('aria-invalid')).toBe('true')
    expect(identityInput.getAttribute('aria-describedby')).toBe('ssh-identity-error')

    act(() => {
      setInputValue(identityInput, '~/.ssh/id_ed25519')
    })
    expect(container.textContent).not.toContain('An identity file is required for this auth method')
    expect(identityInput.getAttribute('aria-invalid')).toBeNull()
  })


  it('typing a different name into the save-as field while editing does not clone the profile — it stays the edited name', () => {
    const onSaveProfile = vi.fn()
    const p = profile()
    act(() => {
      root.render(
        <SshConnectModal
          profiles={[p]}
          onConnect={() => {}}
          onSaveProfile={onSaveProfile}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })

    act(() => {
      container.querySelector<HTMLButtonElement>(`[aria-label="Edit profile ${p.name}"]`)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    const saveAsCheckbox = container.querySelector<HTMLButtonElement>('[data-testid="ssh-save-as-profile"]')
    act(() => {
      saveAsCheckbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="profile name…"]')
    if (nameInput) {
      act(() => {
        setInputValue(nameInput, 'staging-box')
      })
    }

    expect(container.textContent).toContain('Saving as')
    expect(container.textContent).toContain(p.name)
    expect(container.textContent).not.toContain('staging-box')

    act(() => {
      findButton('Save without connecting')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSaveProfile).toHaveBeenCalledTimes(1)
    expect(onSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: p.name }))
    expect(onSaveProfile).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'staging-box' }))
  })


  it('keeps focus inside the dialog when entering and leaving edit mode', () => {
    const p = profile()
    act(() => {
      root.render(
        <SshConnectModal
          profiles={[p]}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })

    const editButton = container.querySelector<HTMLButtonElement>(`[aria-label="Edit profile ${p.name}"]`)!
    act(() => {
      editButton.focus()
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.contains(document.activeElement)).toBe(true)

    const cancelBanner = findButton('Cancel')!
    act(() => {
      cancelBanner.focus()
      cancelBanner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.contains(document.activeElement)).toBe(true)
  })
})
