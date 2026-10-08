import { lazy, Suspense } from 'react'
import type { ComponentType } from 'react'

// A code-split component that renders synchronously once loaded; plain `lazy` suspends on
// first mount, so popovers would open a frame late. Call `preload` on idle or in `beforeAll`.
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>): {
  Slot: (props: P) => React.JSX.Element
  preload: () => Promise<{ default: ComponentType<P> }>
} {
  let loaded: ComponentType<P> | null = null
  const preload = (): Promise<{ default: ComponentType<P> }> =>
    load().then((component) => {
      loaded = component
      return { default: component }
    })
  const Lazy = lazy(preload)
  function Slot(props: P): React.JSX.Element {
    const Loaded = loaded
    if (Loaded) return <Loaded {...props} />
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    )
  }
  return { Slot, preload }
}
