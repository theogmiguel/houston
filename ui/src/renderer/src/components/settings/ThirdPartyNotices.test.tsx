// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThirdPartyNotices } from './ThirdPartyNotices'

const { thirdPartyLicensesMock } = vi.hoisted(() => ({ thirdPartyLicensesMock: vi.fn() }))
vi.mock('../../houston/bridge', () => ({
  thirdPartyLicenses: () => thirdPartyLicensesMock()
}))

const FIXTURE = {
  texts: {
    t1: 'MIT licence text for alpha, line one.\nline two.',
    t2: 'Apache-2.0 licence text for gamma.'
  },
  packages: [
    {
      origin: 'cargo',
      name: 'alpha',
      version: '1.2.3',
      license: 'MIT',
      repository: 'https://example.com/alpha',
      textIds: ['t1']
    },
    {
      origin: 'npm',
      name: 'beta',
      version: '0.1.0',
      license: null,
      repository: null,
      textIds: []
    },
    {
      origin: 'cargo',
      name: 'gamma',
      version: '2.0.0',
      license: 'Apache-2.0',
      repository: 'https://example.com/gamma',
      textIds: ['t2']
    },
    {
      origin: 'asset',
      name: 'delta',
      version: '3.1.0',
      license: 'BSD-3-Clause',
      repository: null,
      note: 'Vendored, not linked.',
      textIds: []
    }
  ]
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function openPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Show notices' }))
}

describe('ThirdPartyNotices', () => {
  beforeEach(() => {
    thirdPartyLicensesMock.mockReset()
    thirdPartyLicensesMock.mockResolvedValue(JSON.stringify(FIXTURE))
  })

  afterEach(cleanup)

  it('fetches nothing until the panel is opened, then fetches once', async () => {
    render(<ThirdPartyNotices />)
    expect(thirdPartyLicensesMock).not.toHaveBeenCalled()

    openPanel()
    await flush()

    expect(thirdPartyLicensesMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText('4 of 4 packages')).not.toBeNull()
  })

  it('shows a package licence text only after its own control is clicked', async () => {
    render(<ThirdPartyNotices />)
    openPanel()
    await flush()

    expect(screen.queryByText(/MIT licence text for alpha/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show licence for alpha' }))
    expect(screen.getByText(/MIT licence text for alpha/)).not.toBeNull()
    expect(screen.queryByText(/Apache-2.0 licence text for gamma/)).toBeNull()
  })

  it('narrows the list and the count line follows the filter', async () => {
    render(<ThirdPartyNotices />)
    openPanel()
    await flush()

    expect(screen.getByText('4 of 4 packages')).not.toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'gamma' } })

    expect(screen.getByText('1 of 4 packages')).not.toBeNull()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('gamma')).not.toBeNull()
  })

  it('puts a rejected bridge call message on screen verbatim', async () => {
    const message =
      'the third-party licence inventory (system_third_party_licenses) is only available in the desktop app'
    thirdPartyLicensesMock.mockRejectedValueOnce(new Error(message))

    render(<ThirdPartyNotices />)
    openPanel()
    await flush()

    expect(screen.getByText(message)).not.toBeNull()
  })
})
