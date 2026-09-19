import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  BACKGROUND_OVERRIDE_MESSAGE,
  bumpImageVersion,
  setChromeScrim,
  setCeiling,
  setColorSteps,
  setFadeStop,
  setFieldOpacity,
  setMode,
  setOriginalColors,
  setPaneScrim,
  setPixelSize,
  setPreset,
  useBackgroundOverrideReason,
  useBackgroundState,
  useStoredBackgroundMode
} from '../../backgroundMode'
import { PRESETS, USER_IMAGE } from '../../backdrop/source'
import { isTauri } from '../../houston/host'
import { FOCUS_HALO } from '../shadowChrome'
import { BTN_GHOST, BTN_GHOST_DANGER_HOVER } from '../buttonChrome'
import { Segmented } from '../Segmented'
import { Slider } from '../Slider'
import { SettingsList, Toggle } from '../settingsPrimitives'
import { Group, Row } from './shared'
import { BackgroundPreview, PresetThumb } from './BackgroundPreview'
import { CHROME_THEME_LABELS, type ChromeTheme, type TerminalPalette } from '../../theme'

// Bounds decode cost only, not display quality — the field downsamples any
// source anyway. Rust can't check this itself without pulling in the image crate.
export const WINDOW_BACKGROUND_MAX_PIXELS = 12_000_000

interface WindowBackgroundInfo {
  filename: string
  size: number
  ext: string
}

const FADE_OFF = 100
const FADE_ON = 88

const BACKGROUND_DEFAULTS = {
  mode: 'solid',
  preset: 'graphite',
  pixelSize: 2,
  colorSteps: 4,
  originalColors: true,
  fieldOpacity: 100,
  chromeScrim: 72,
  paneScrim: 35,
  ceiling: 35,
  fadeStop: 100
} as const

function asciiAt(bytes: Uint8Array, offset: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (bytes[offset + i] !== s.charCodeAt(i)) return false
  }
  return true
}

function isAnimatedImage(bytes: Uint8Array): boolean {
  if (asciiAt(bytes, 0, 'GIF')) return gifFrameCount(bytes) > 1
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return hasWebpAnmf(bytes)
  return false
}

function gifFrameCount(bytes: Uint8Array): number {
  let frames = 0
  let i = 13
  while (i < bytes.length) {
    const b = bytes[i]
    if (b === 0x3b) break
    if (b === 0x2c) {
      frames++
      const flags = bytes[i + 9] ?? 0
      i += 10
      if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1))
      i++
      while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i]
      i++
    } else if (b === 0x21) {
      i += 2
      while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i]
      i++
    } else {
      i++
    }
  }
  return frames
}

function hasWebpAnmf(bytes: Uint8Array): boolean {
  for (let i = 12; i + 4 <= bytes.length; i++) {
    if (asciiAt(bytes, i, 'ANMF')) return true
  }
  return false
}

async function removeWindowBackground(): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke('fs_remove_window_background')
  } catch {
  }
}

async function pickWindowImage(handlers: {
  onError: (message: string) => void
  onAccepted: () => void
  onRejected: (hasSlot: boolean) => void
}): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  let path: string | null
  try {
    path = await invoke<string | null>('dialog_pick_image')
  } catch (e) {
    handlers.onError(e instanceof Error ? e.message : String(e))
    return
  }
  if (!path) return
  const name = path.split(/[\\/]/).pop() ?? path
  try {
    await invoke<string>('fs_set_window_background', { path })
  } catch (e) {
    handlers.onError(e instanceof Error ? e.message : String(e))
    return
  }
  let bytes: ArrayBuffer
  try {
    bytes = await invoke<ArrayBuffer>('fs_read_window_background')
  } catch (e) {
    handlers.onError(e instanceof Error ? e.message : String(e))
    return
  }
  const refuse = async (why: string): Promise<void> => {
    const hasSlot = await invoke<boolean>('fs_settle_window_background', { keep: 'previous' })
    handlers.onError(
      `${why} — ${hasSlot ? 'your previous background is back' : 'nothing was kept'}.`
    )
    handlers.onRejected(hasSlot)
  }
  const u8 = new Uint8Array(bytes)
  if (isAnimatedImage(u8)) {
    await refuse(
      `${name} is an animated image; Houston refuses animated backgrounds (a still .gif or .webp is fine)`
    )
    return
  }
  let w: number
  let h: number
  try {
    const bmp = await createImageBitmap(new Blob([u8]))
    w = bmp.width
    h = bmp.height
  } catch {
    await refuse(`${name} loaded but could not be decoded here`)
    return
  }
  if (w * h > WINDOW_BACKGROUND_MAX_PIXELS) {
    await refuse(
      `${name} is ${w}×${h} (${(w * h).toLocaleString()}px), over the ${WINDOW_BACKGROUND_MAX_PIXELS.toLocaleString()}px cap`
    )
    return
  }
  await invoke('fs_settle_window_background', { keep: 'new' })
  handlers.onAccepted()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function PresetTiles({
  value,
  dark,
  onSelect
}: {
  value: string
  dark: boolean
  onSelect: (id: string) => void
}): JSX.Element {
  const tiles: { id: string; label: string; tag: string }[] = [
    ...PRESETS.map((id) => ({
      id,
      label: CHROME_THEME_LABELS[id as ChromeTheme] ?? id,
      tag: 'Bundled'
    })),
    { id: USER_IMAGE, label: 'Your image', tag: 'Yours' }
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Background image"
      className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-[var(--space-2)] px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-4)]"
    >
      {tiles.map((t) => {
        const on = value === t.id
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid="background-preset-tile"
            data-preset={t.id}
            onClick={() => onSelect(t.id)}
            className={`btn flex flex-col p-0 overflow-hidden rounded-[var(--tr-radius-card)] border text-left whitespace-normal focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] [transition:border-color_.12s_ease] ${
              on
                ? 'border-[var(--accent)] bg-[var(--card-bg)]'
                : 'border-[var(--border)] hover:border-[var(--border-hover)] bg-[var(--card-bg)]'
            }`}
          >
            <PresetThumb preset={t.id} dark={dark} />
            <span className="flex w-full items-center justify-between gap-[var(--space-1-5)] border-t border-t-[var(--divider)] px-[var(--space-2-5)] py-[var(--space-2)]">
              <b className="min-w-0 truncate text-[length:var(--tr-text-small-size)] font-medium text-[var(--text-primary)]">
                {t.label}
              </b>
              <span
                className={`shrink-0 font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase ${
                  on ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'
                }`}
              >
                {t.tag}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ImageFileRow({
  info,
  thumbUrl,
  error,
  onChoose,
  onRemove
}: {
  info: WindowBackgroundInfo | null | undefined
  thumbUrl: string | null
  error: string | null
  onChoose: () => void
  onRemove: () => void
}): JSX.Element {
  return (
    <div className="border-t border-t-[var(--divider)] px-[var(--space-4)] py-[var(--space-3)]">
    <div data-testid="background-image-row" className="flex items-center gap-[var(--space-3)]">
      {info ? (
        <>
          {thumbUrl ? (
            <img
              data-testid="background-image-thumb"
              src={thumbUrl}
              alt={info.filename}
              className="h-[30px] w-[44px] flex-none rounded-[var(--tr-radius-sm)] border border-[var(--divider)] object-cover"
            />
          ) : (
            <span className="h-[30px] w-[44px] flex-none rounded-[var(--tr-radius-sm)] border border-[var(--divider)]" />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <span
              data-testid="background-image-filename"
              className="block truncate font-mono text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)]"
            >
              {info.filename}
            </span>
            <span className="block text-[length:var(--tr-text-small-size)] tabular-nums text-[var(--text-faint)]">
              {formatBytes(info.size)} · kept in this channel&rsquo;s state directory
            </span>
          </span>
          <button
            type="button"
            data-testid="background-image-choose"
            className={`btn ${BTN_GHOST} flex-none px-[var(--space-2)]`}
            onClick={onChoose}
          >
            Replace&hellip;
          </button>
          <button
            type="button"
            data-testid="background-image-remove"
            className={`btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER} flex-none px-[var(--space-2)]`}
            onClick={onRemove}
          >
            Remove
          </button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]">
            No image of your own yet.
          </span>
          <button
            type="button"
            data-testid="background-image-choose"
            className={`btn ${BTN_GHOST} flex-none px-[var(--space-2)]`}
            onClick={onChoose}
          >
            Choose&hellip;
          </button>
        </>
      )}
    </div>
      {}
      {error && (
        <p
          data-testid="background-image-error"
          className="m-0 pt-[var(--space-2)] text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--danger)]"
        >
          {error}
        </p>
      )}
    </div>
  )
}

function Advanced({ children }: { children: ReactNode }): JSX.Element {
  return (
    <details
      data-testid="background-advanced"
      className="border border-[var(--border)] rounded-[var(--tr-radius-md)] bg-[var(--card-bg)] overflow-hidden [&[open]>summary]:border-b [&[open]>summary]:border-b-[var(--divider)]"
    >
      <summary
        className={`flex cursor-pointer list-none items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-secondary)] marker:content-none [&::-webkit-details-marker]:hidden focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] hover:text-[var(--text-primary)]`}
      >
        <span aria-hidden className="text-[var(--text-faint)] [font-size:var(--tr-text-label-size)]">
          &#9656;
        </span>
        Fade and reset
      </summary>
      {children}
    </details>
  )
}

export interface WindowBackgroundGroupProps {
  chromeTheme: ChromeTheme
  palette: TerminalPalette
}

export function WindowBackgroundGroup({
  chromeTheme,
  palette
}: WindowBackgroundGroupProps): JSX.Element {
  const bg = useBackgroundState()
  const storedMode = useStoredBackgroundMode()
  const overrideReason = useBackgroundOverrideReason()
  const dark = chromeTheme === 'graphite'

  const [imageInfo, setImageInfo] = useState<WindowBackgroundInfo | null | undefined>(undefined)
  const [imageThumbUrl, setImageThumbUrl] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const thumbUrlRef = useRef<string | null>(null)

  const refreshImage = useCallback(async (): Promise<void> => {
    if (!isTauri()) {
      setImageInfo(null)
      return
    }
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      const info = await invoke<WindowBackgroundInfo | null>('fs_window_background_info')
      setImageInfo(info)
      if (thumbUrlRef.current) {
        URL.revokeObjectURL(thumbUrlRef.current)
        thumbUrlRef.current = null
        setImageThumbUrl(null)
      }
      if (info) {
        const bytes = await invoke<ArrayBuffer>('fs_read_window_background')
        const url = URL.createObjectURL(new Blob([bytes]))
        thumbUrlRef.current = url
        setImageThumbUrl(url)
      }
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refreshImage()
    return () => {
      if (thumbUrlRef.current) URL.revokeObjectURL(thumbUrlRef.current)
    }
  }, [refreshImage])

  const onChoose = (): void => {
    setImageError(null)
    void pickWindowImage({
      onError: (m) => setImageError(m),
      onAccepted: () => {
        bumpImageVersion()
        setPreset(USER_IMAGE)
        void refreshImage()
      },
      onRejected: (hasSlot) => {
        bumpImageVersion()
        setPreset(hasSlot ? USER_IMAGE : PRESETS[0])
        void refreshImage()
      }
    })
  }

  const onRemove = (): void => {
    setImageError(null)
    void removeWindowBackground().then(refreshImage)
    bumpImageVersion()
    setPreset(PRESETS[0])
  }

  const onReset = (): void => {
    setImageError(null)
    setMode('solid')
    setPreset(BACKGROUND_DEFAULTS.preset)
    setPixelSize(BACKGROUND_DEFAULTS.pixelSize)
    setColorSteps(BACKGROUND_DEFAULTS.colorSteps)
    setOriginalColors(BACKGROUND_DEFAULTS.originalColors)
    setFieldOpacity(BACKGROUND_DEFAULTS.fieldOpacity)
    setChromeScrim(BACKGROUND_DEFAULTS.chromeScrim)
    setPaneScrim(BACKGROUND_DEFAULTS.paneScrim)
    setCeiling(BACKGROUND_DEFAULTS.ceiling)
    setFadeStop(BACKGROUND_DEFAULTS.fadeStop)
    bumpImageVersion()
    void removeWindowBackground().then(refreshImage)
  }

  const custom = storedMode === 'custom'

  return (
    <>
      <Group heading="Window background">
        <SettingsList>
          {custom && (
            <div className="px-[var(--space-4)] pt-[var(--space-4)] pb-[var(--space-3)]">
              <BackgroundPreview chromeTheme={chromeTheme} palette={palette} />
            </div>
          )}
          <Row title="Background">
            <Segmented<'solid' | 'custom'>
              aria-label="Background"
              options={[
                { value: 'solid', label: 'Solid' },
                {
                  value: 'custom',
                  label: 'Custom',
                  disabled: overrideReason !== null,
                  disabledReason: overrideReason ? BACKGROUND_OVERRIDE_MESSAGE[overrideReason] : undefined
                }
              ]}
              value={storedMode}
              onChange={setMode}
            />
          </Row>
        </SettingsList>
      </Group>

      {custom && (
        <>
          <Group heading="Image" plain>
            <SettingsList>
              <PresetTiles value={bg.preset} dark={dark} onSelect={setPreset} />
              <ImageFileRow
                info={imageInfo}
                thumbUrl={imageThumbUrl}
                error={imageError}
                onChoose={onChoose}
                onRemove={onRemove}
              />
            </SettingsList>
          </Group>

          <Group heading="Style">
            <Row title="Pixel size">
              <Slider
                aria-label="Pixel size"
                value={bg.pixelSize}
                min={1}
                max={4}
                onChange={setPixelSize}
                resetValue={BACKGROUND_DEFAULTS.pixelSize}
                onReset={() => setPixelSize(BACKGROUND_DEFAULTS.pixelSize)}
              />
            </Row>

            <Row title="Colour" desc="Off is monochrome.">
              <Toggle
                on={bg.originalColors}
                onChange={setOriginalColors}
                data-testid="background-original-colours"
              />
            </Row>

            <Row
              title={
                <>
                  Brightness
                  <CapTag>max 44%</CapTag>
                </>
              }
              desc="The cap keeps the rail's smallest text readable over any picture."
            >
              <Slider
                aria-label="Brightness"
                value={bg.ceiling}
                min={20}
                max={44}
                onChange={setCeiling}
                formatValue={(v) => `${v}%`}
                resetValue={BACKGROUND_DEFAULTS.ceiling}
                onReset={() => setCeiling(BACKGROUND_DEFAULTS.ceiling)}
              />
            </Row>
          </Group>

          <Group heading="Coats">
            <Row
              title={
                <>
                  Chrome
                  <CapTag>min 60%</CapTag>
                </>
              }
              desc="Rail and titlebar. Lower shows more picture."
            >
              <Slider
                aria-label="Chrome coat"
                value={bg.chromeScrim}
                min={60}
                max={100}
                onChange={setChromeScrim}
                formatValue={(v) => `${v}%`}
                resetValue={BACKGROUND_DEFAULTS.chromeScrim}
                onReset={() => setChromeScrim(BACKGROUND_DEFAULTS.chromeScrim)}
              />
            </Row>

            <Row title="Panes" desc="Terminal, Git, Files, editor and Skills panes. The browser stays opaque.">
              <Slider
                aria-label="Pane coat"
                value={bg.paneScrim}
                min={5}
                max={100}
                onChange={setPaneScrim}
                formatValue={(v) => `${v}%`}
                resetValue={BACKGROUND_DEFAULTS.paneScrim}
                onReset={() => setPaneScrim(BACKGROUND_DEFAULTS.paneScrim)}
              />
            </Row>
          </Group>

          <Group heading="Advanced" plain>
            <div className="flex flex-col gap-[var(--space-2)] pt-[var(--space-2)]">
              <Advanced>
                <Row title="Fade the bottom edge" desc="Blends the last tenth of the window into the theme.">
                  <Toggle
                    on={bg.fadeStop < FADE_OFF}
                    onChange={(on) => setFadeStop(on ? FADE_ON : FADE_OFF)}
                    data-testid="background-fade"
                  />
                </Row>

                <Row title="Reset window background" desc="Back to Solid, defaults restored, your image removed.">
                  <button
                    type="button"
                    data-testid="background-reset"
                    className={`btn ${BTN_GHOST}`}
                    onClick={onReset}
                  >
                    Reset
                  </button>
                </Row>
              </Advanced>
            </div>
          </Group>
        </>
      )}
    </>
  )
}

function CapTag({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="flex-none rounded-[var(--tr-radius-input)] border border-[var(--divider)] px-[var(--space-1)] font-mono [font-size:var(--tr-text-label-size)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">
      {children}
    </span>
  )
}
