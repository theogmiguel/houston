import React from 'react'
import { BTN_GHOST } from './buttonChrome'
import { SURFACE_CRASH_GUARANTEE } from './crashCopy'

interface Props {
  label: string
  children: React.ReactNode
}

interface State {
  error: Error | null
}

export class SurfaceBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`SurfaceBoundary(${this.props.label}) caught:`, error, info.componentStack)
  }

  private retry = (): void => this.setState({ error: null })

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2.5 p-4 text-center text-danger">
        <p>
          {this.props.label} crashed: {error.message}
        </p>
        <p className="text-[var(--text-muted)]">{SURFACE_CRASH_GUARANTEE}</p>
        <button className={`btn ${BTN_GHOST}`} onClick={this.retry}>
          Retry
        </button>
      </div>
    )
  }
}
