import { useBackgroundState } from '../backgroundMode'

// `undefined`, not `'off'`: the attribute must be ABSENT off-custom — a falsy
// string still matches `[data-custom]` and would light every custom rule.
export function useCustomSurface(): { custom: boolean; dataCustom: 'on' | undefined } {
  const { mode } = useBackgroundState()
  const custom = mode === 'custom'
  return { custom, dataCustom: custom ? 'on' : undefined }
}
