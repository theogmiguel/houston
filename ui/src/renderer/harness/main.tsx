import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/500.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '../src/tailwind.css'
import '../src/keyframes.css'
import '../src/theme.css'
import '../src/base.css'
import '../src/global.css'
import { STORIES } from './stories'

const params = new URLSearchParams(window.location.search)
const story = params.get('story') ?? ''
const theme = params.get('theme')
if (theme) document.documentElement.dataset.theme = theme

function Index(): React.JSX.Element {
  return (
    <div style={{ padding: 24, color: 'var(--text-primary)', fontFamily: 'var(--font-sans, sans-serif)' }}>
      <h1 style={{ fontSize: 16, margin: '0 0 12px' }}>Houston harness — stories</h1>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
        {Object.keys(STORIES).map((name) => (
          <li key={name}>
            <a href={`?story=${encodeURIComponent(name)}`} style={{ color: 'var(--accent)' }}>
              {name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

const Story = STORIES[story]
const root = document.getElementById('root')
if (!root) throw new Error('harness: #root missing from index.html')
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {Story ? (
      <div style={{ width: '100vw', height: '100vh', background: 'var(--background)', overflow: 'hidden' }}>
        <Story />
      </div>
    ) : (
      <Index />
    )}
  </React.StrictMode>
)
