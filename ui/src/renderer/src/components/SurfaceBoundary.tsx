import React from 'react'
import { SurfaceCrash } from './ui/SurfaceCrash'
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
      <SurfaceCrash
        message={`${this.props.label} crashed: ${error.message}`}
        guarantee={SURFACE_CRASH_GUARANTEE}
        onRetry={this.retry}
      />
    )
  }
}
