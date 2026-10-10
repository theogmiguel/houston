// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useMascotLifecycle, useReportMascotLifecycle } from './mascotLifecycle'
function Reporter({ count, firstRun }: { count: number; firstRun: boolean }): null {
  useReportMascotLifecycle(count, firstRun, false)
  return null
}
function Read(): React.JSX.Element {
  const state = useMascotLifecycle()
  return <output data-testid="lifecycle">{JSON.stringify(state)}</output>
}
afterEach(cleanup)
it('keeps onboarding/workspace lifecycle current without a mounted Sidebar', () => {
  const view = render(<><Reporter count={0} firstRun /><Read /></>)
  expect(JSON.parse(screen.getByTestId('lifecycle').textContent!)).toEqual({ existingUser: false, firstRun: true })
  view.rerender(<><Reporter count={1} firstRun={false} /><Read /></>)
  expect(JSON.parse(screen.getByTestId('lifecycle').textContent!)).toEqual({ existingUser: true, firstRun: false })
})
