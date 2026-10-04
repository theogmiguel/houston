import { createRoot } from 'react-dom/client'
import { ThemeRevealSpecimen } from '../src/renderer/src/components/ui/ThemeRevealSpecimen'
import '../src/renderer/src/tailwind.css'
import '../src/renderer/src/theme.css'
import '../src/renderer/src/base.css'
import '../src/renderer/src/global.css'

createRoot(document.getElementById('root')!).render(
  <main className="mx-auto grid max-w-[1200px] gap-[var(--space-4)] p-[var(--space-4)]">
    <ThemeRevealSpecimen />
  </main>
)
