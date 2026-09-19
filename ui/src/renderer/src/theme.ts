import { setBackgroundColor } from './houston/bridge'

export const CHROME_THEMES = ['graphite', 'paper'] as const
export type ChromeTheme = (typeof CHROME_THEMES)[number]

export const CHROME_THEME_LABELS: Record<ChromeTheme, string> = {
  graphite: 'Graphite',
  paper: 'Paper'
}

export const CHROME_THEME_MODES: Record<ChromeTheme, ThemeMode> = {
  graphite: 'dark',
  paper: 'light'
}

export const CHROME_STORAGE_KEY = 'tr-chrome-theme'
export const DEFAULT_CHROME_THEME: ChromeTheme = 'graphite'

export const DEFAULT_TERMINAL_PALETTE_FOR_CHROME: Record<ChromeTheme, ThemeName> = {
  graphite: 'black',
  paper: 'marble'
}

export const AUTO_TERMINAL_PALETTE = 'auto' as const
export type TerminalPaletteChoice = ThemeName | typeof AUTO_TERMINAL_PALETTE

export function resolveTerminalPalette(
  choice: TerminalPaletteChoice,
  chromeTheme: ChromeTheme
): ThemeName {
  return choice === AUTO_TERMINAL_PALETTE ? DEFAULT_TERMINAL_PALETTE_FOR_CHROME[chromeTheme] : choice
}

const RETIRED_CHROME_THEMES: Record<string, ChromeTheme> = {
  'warm-espresso': 'graphite',
  system: 'graphite'
}

export function remapThemeToChrome(theme: ThemeName): ChromeTheme {
  return THEME_MODES[theme] === 'light' ? 'paper' : 'graphite'
}

export function loadChromeTheme(): {
  theme: ChromeTheme
  migratedFrom: ThemeName | null
} {
  const savedChrome = localStorage.getItem(CHROME_STORAGE_KEY)
  if (CHROME_THEMES.includes(savedChrome as ChromeTheme)) {
    return { theme: savedChrome as ChromeTheme, migratedFrom: null }
  }
  if (savedChrome !== null && savedChrome in RETIRED_CHROME_THEMES) {
    return { theme: RETIRED_CHROME_THEMES[savedChrome], migratedFrom: null }
  }
  const legacy = localStorage.getItem(STORAGE_KEY)
  if (THEMES.includes(legacy as ThemeName)) {
    const legacyTheme = legacy as ThemeName
    return { theme: remapThemeToChrome(legacyTheme), migratedFrom: legacyTheme }
  }
  return { theme: DEFAULT_CHROME_THEME, migratedFrom: null }
}

export function applyChromeTheme(theme: ChromeTheme): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem(CHROME_STORAGE_KEY, theme)
}

export interface TerminalPalette {
  background?: string
  foreground?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

export const THEMES = [
  'warm-espresso', 'black', 'light', 'warp-dark', 'warp-light', 'dracula', 'solarized-light', 'solarized-dark', 'gruvbox-dark', 'gruvbox-light', 'cyber-wave', 'willow-dream', 'fancy-dracula', 'phenomenon', 'jellyfish', 'koi', 'leafy', 'marble', 'pink-city', 'snowy', 'red-rock', 'dark-city', 'solar-flare', 'adeberry'
] as const
export type ThemeName = (typeof THEMES)[number]

export const THEME_LABELS: Record<ThemeName, string> = {
  'warm-espresso': 'Warm Espresso',
  'black': 'Black',
  'light': 'Light',
  'warp-dark': 'Warp Dark',
  'warp-light': 'Warp Light',
  'dracula': 'Dracula',
  'solarized-light': 'Solarized Light',
  'solarized-dark': 'Solarized Dark',
  'gruvbox-dark': 'Gruvbox Dark',
  'gruvbox-light': 'Gruvbox Light',
  'cyber-wave': 'Cyber Wave',
  'willow-dream': 'Willow Dream',
  'fancy-dracula': 'Fancy Dracula',
  'phenomenon': 'Phenomenon',
  'jellyfish': 'Jellyfish',
  'koi': 'Koi',
  'leafy': 'Leafy',
  'marble': 'Marble',
  'pink-city': 'Pink City',
  'snowy': 'Snowy',
  'red-rock': 'Red Rock',
  'dark-city': 'Dark City',
  'solar-flare': 'Solar Flare',
  'adeberry': 'Adeberry'
}

export const THEME_DESCRIPTIONS: Record<ThemeName, string> = {
  'warm-espresso': 'Dark roast browns, burnt-orange accent',
  'black': 'True black, crisp white text and cursor',
  'light': 'Clean white with cool blue accent',
  'warp-dark': 'Near-black with an electric cyan accent',
  'warp-light': 'Bright white with a vivid sky-blue accent',
  'dracula': 'Classic slate purple with hot-pink accent',
  'solarized-light': 'Warm cream paper with muted teal accent',
  'solarized-dark': 'Deep teal-black with burnt-orange accent',
  'gruvbox-dark': 'Warm charcoal with a retro orange accent',
  'gruvbox-light': 'Cream parchment with a rust accent',
  'cyber-wave': 'Inky midnight teal with an indigo accent',
  'willow-dream': 'Deep teal-green with a soft coral accent',
  'fancy-dracula': 'Muted slate-purple with a pale periwinkle accent',
  'phenomenon': 'Near-black with a steel-blue accent',
  'jellyfish': 'Dark plum-black with a muted teal accent',
  'koi': 'Dark maroon-black with a fiery red accent',
  'leafy': 'True black with a mossy green accent',
  'marble': 'Light stone gray with a charcoal accent',
  'pink-city': 'Soft blush pink with a magenta accent',
  'snowy': 'Icy pale gray-blue with a slate accent',
  'red-rock': 'Dark plum-gray with a dusty red accent',
  'dark-city': 'Deep teal-navy with a crimson accent',
  'solar-flare': 'Warm near-black with a jade-green accent',
  'adeberry': 'Cool slate charcoal with a dusty blue accent'
}

export type ThemeMode = 'dark' | 'light'

export function deriveThemeMode(backgroundHex: string): ThemeMode {
  const hex = backgroundHex.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? 'light' : 'dark'
}

export const THEME_MODES: Record<ThemeName, ThemeMode> = {
  'warm-espresso': 'dark',
  'black': 'dark',
  'light': 'light',
  'warp-dark': 'dark',
  'warp-light': 'light',
  'dracula': 'dark',
  'solarized-light': 'light',
  'solarized-dark': 'dark',
  'gruvbox-dark': 'dark',
  'gruvbox-light': 'light',
  'cyber-wave': 'dark',
  'willow-dream': 'dark',
  'fancy-dracula': 'dark',
  'phenomenon': 'dark',
  'jellyfish': 'dark',
  'koi': 'dark',
  'leafy': 'dark',
  'marble': 'light',
  'pink-city': 'light',
  'snowy': 'light',
  'red-rock': 'dark',
  'dark-city': 'dark',
  'solar-flare': 'dark',
  'adeberry': 'dark'
}

export const TERMINAL_PALETTES: Record<ThemeName, TerminalPalette> = {
  'warm-espresso': {
    background: '#150d08',
    foreground: '#d8c4b0',
    cursor: '#d6683c',
    cursorAccent: '#150d08',
    selectionBackground: '#4a3324',
    black: '#2a1d14',
    red: '#f09595',
    green: '#79d79a',
    yellow: '#f0c674',
    blue: '#7eb6ff',
    magenta: '#d0b7ff',
    cyan: '#19d3c5',
    white: '#d8c4b0',
    brightBlack: '#7a6857',
    brightRed: '#f7b6b6',
    brightGreen: '#b8e3be',
    brightYellow: '#ffbf69',
    brightBlue: '#a3ccff',
    brightMagenta: '#e2d4ff',
    brightCyan: '#5fe6da',
    brightWhite: '#fff8f0'
  },
  'black': {
    background: '#000000',
    foreground: '#EBEBEB',
    cursor: '#FFFFFF',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(255, 255, 255, 0.15)',
    selectionForeground: '#EBEBEB',
    black: '#0a0a0a',
    red: '#F87171',
    green: '#4ADE80',
    yellow: '#FACC15',
    blue: '#93C5FD',
    magenta: '#E879F9',
    cyan: '#67E8F9',
    white: '#A3A3A3',
    brightBlack: '#525252',
    brightRed: '#FCA5A5',
    brightGreen: '#86EFAC',
    brightYellow: '#FDE68A',
    brightBlue: '#BFDBFE',
    brightMagenta: '#F0ABFC',
    brightCyan: '#A5F3FC',
    brightWhite: '#E5E5E5'
  },
  'light': {
    background: '#FAFBFC',
    foreground: '#1A1D26',
    cursor: '#2563EB',
    cursorAccent: '#FAFBFC',
    selectionBackground: 'rgba(37, 99, 235, 0.18)',
    selectionForeground: '#1A1D26',
    black: '#1E293B',
    red: '#DC2626',
    green: '#16A34A',
    yellow: '#CA8A04',
    blue: '#2563EB',
    magenta: '#9333EA',
    cyan: '#0891B2',
    white: '#64748B',
    brightBlack: '#475569',
    brightRed: '#B91C1C',
    brightGreen: '#15803D',
    brightYellow: '#A16207',
    brightBlue: '#1D4ED8',
    brightMagenta: '#7C3AED',
    brightCyan: '#0E7490',
    brightWhite: '#94A3B8'
  },
  'warp-dark': {
    background: '#000000',
    foreground: '#FFFFFF',
    cursor: '#19AAD8',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(25, 170, 216, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#616161',
    red: '#FF8272',
    green: '#B4FA72',
    yellow: '#FEFDC2',
    blue: '#A5D5FE',
    magenta: '#FF8FFD',
    cyan: '#D0D1FE',
    white: '#F1F1F1',
    brightBlack: '#8E8E8E',
    brightRed: '#FFC4BD',
    brightGreen: '#D6FCB9',
    brightYellow: '#FEFDD5',
    brightBlue: '#C1E3FE',
    brightMagenta: '#FFB1FE',
    brightCyan: '#E5E6FE',
    brightWhite: '#FEFFFF'
  },
  'warp-light': {
    background: '#FFFFFF',
    foreground: '#111111',
    cursor: '#00C2FF',
    cursorAccent: '#FFFFFF',
    selectionBackground: 'rgba(0, 194, 255, 0.280)',
    selectionForeground: '#111111',
    black: '#212121',
    red: '#C30771',
    green: '#10A778',
    yellow: '#A89C14',
    blue: '#008EC4',
    magenta: '#523C79',
    cyan: '#20A5BA',
    white: '#E0E0E0',
    brightBlack: '#212121',
    brightRed: '#FB007A',
    brightGreen: '#5FD7AF',
    brightYellow: '#F3E430',
    brightBlue: '#20BBFC',
    brightMagenta: '#6855DE',
    brightCyan: '#4FB8CC',
    brightWhite: '#F1F1F1'
  },
  'dracula': {
    background: '#282A36',
    foreground: '#F8F8F2',
    cursor: '#FF79C6',
    cursorAccent: '#282A36',
    selectionBackground: 'rgba(255, 121, 198, 0.280)',
    selectionForeground: '#F8F8F2',
    black: '#000000',
    red: '#FF5555',
    green: '#50FA7B',
    yellow: '#F1FA8C',
    blue: '#BD93F9',
    magenta: '#FF79C6',
    cyan: '#8BE9FD',
    white: '#BBBBBB',
    brightBlack: '#555555',
    brightRed: '#FF5555',
    brightGreen: '#50FA7B',
    brightYellow: '#F1FA8C',
    brightBlue: '#CAA9FA',
    brightMagenta: '#FF79C6',
    brightCyan: '#8BE9FD',
    brightWhite: '#FFFFFF'
  },
  'solarized-light': {
    background: '#FDF6E3',
    foreground: '#586E75',
    cursor: '#66B5A9',
    cursorAccent: '#FDF6E3',
    selectionBackground: 'rgba(102, 181, 169, 0.280)',
    selectionForeground: '#586E75',
    black: '#073642',
    red: '#DC322F',
    green: '#859900',
    yellow: '#B58900',
    blue: '#268BD2',
    magenta: '#D33682',
    cyan: '#2AA198',
    white: '#EEE8D5',
    brightBlack: '#002B36',
    brightRed: '#CB4B16',
    brightGreen: '#586E75',
    brightYellow: '#657B83',
    brightBlue: '#839496',
    brightMagenta: '#6C71C4',
    brightCyan: '#93A1A1',
    brightWhite: '#FDF6E3'
  },
  'solarized-dark': {
    background: '#002B36',
    foreground: '#F8F8F2',
    cursor: '#CB4B16',
    cursorAccent: '#002B36',
    selectionBackground: 'rgba(203, 75, 22, 0.280)',
    selectionForeground: '#F8F8F2',
    black: '#073642',
    red: '#DC322F',
    green: '#859900',
    yellow: '#B58900',
    blue: '#268BD2',
    magenta: '#D33682',
    cyan: '#2AA198',
    white: '#EEE8D5',
    brightBlack: '#002B36',
    brightRed: '#CB4B16',
    brightGreen: '#586E75',
    brightYellow: '#657B83',
    brightBlue: '#839496',
    brightMagenta: '#6C71C4',
    brightCyan: '#93A1A1',
    brightWhite: '#FDF6E3'
  },
  'gruvbox-dark': {
    background: '#282828',
    foreground: '#EBDBB2',
    cursor: '#FC802D',
    cursorAccent: '#282828',
    selectionBackground: 'rgba(252, 128, 45, 0.280)',
    selectionForeground: '#EBDBB2',
    black: '#282828',
    red: '#CC241D',
    green: '#98971A',
    yellow: '#D79921',
    blue: '#458588',
    magenta: '#B16286',
    cyan: '#689D6A',
    white: '#A89984',
    brightBlack: '#928374',
    brightRed: '#FB4934',
    brightGreen: '#B8BB26',
    brightYellow: '#FABD2F',
    brightBlue: '#83A598',
    brightMagenta: '#D3869B',
    brightCyan: '#8EC07C',
    brightWhite: '#EBDBB2'
  },
  'gruvbox-light': {
    background: '#FBF1C7',
    foreground: '#3C3836',
    cursor: '#AD3B14',
    cursorAccent: '#FBF1C7',
    selectionBackground: 'rgba(173, 59, 20, 0.280)',
    selectionForeground: '#3C3836',
    black: '#FBF1C7',
    red: '#CC241D',
    green: '#98971A',
    yellow: '#D79921',
    blue: '#458588',
    magenta: '#B16286',
    cyan: '#689D6A',
    white: '#7C6F64',
    brightBlack: '#928374',
    brightRed: '#9D0006',
    brightGreen: '#79740E',
    brightYellow: '#B57614',
    brightBlue: '#076678',
    brightMagenta: '#8F3F71',
    brightCyan: '#427B58',
    brightWhite: '#3C3836'
  },
  'cyber-wave': {
    background: '#001319',
    foreground: '#FFFFFF',
    cursor: '#3E3C81',
    cursorAccent: '#001319',
    selectionBackground: 'rgba(62, 60, 129, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#616161',
    red: '#FF8272',
    green: '#B4FA72',
    yellow: '#FEFDC2',
    blue: '#A5D5FE',
    magenta: '#FF8FFD',
    cyan: '#D0D1FE',
    white: '#F1F1F1',
    brightBlack: '#8E8E8E',
    brightRed: '#FFC4BD',
    brightGreen: '#D6FCB9',
    brightYellow: '#FEFDD5',
    brightBlue: '#C1E3FE',
    brightMagenta: '#FFB1FE',
    brightCyan: '#E5E6FE',
    brightWhite: '#FEFFFF'
  },
  'willow-dream': {
    background: '#114848',
    foreground: '#FFFFFF',
    cursor: '#EB8880',
    cursorAccent: '#114848',
    selectionBackground: 'rgba(235, 136, 128, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#616161',
    red: '#FF8272',
    green: '#B4FA72',
    yellow: '#FEFDC2',
    blue: '#A5D5FE',
    magenta: '#FF8FFD',
    cyan: '#D0D1FE',
    white: '#F1F1F1',
    brightBlack: '#8E8E8E',
    brightRed: '#FFC4BD',
    brightGreen: '#D6FCB9',
    brightYellow: '#FEFDD5',
    brightBlue: '#C1E3FE',
    brightMagenta: '#FFB1FE',
    brightCyan: '#E5E6FE',
    brightWhite: '#FEFFFF'
  },
  'fancy-dracula': {
    background: '#313340',
    foreground: '#FFFFFF',
    cursor: '#AFC4F9',
    cursorAccent: '#313340',
    selectionBackground: 'rgba(175, 196, 249, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#000000',
    red: '#FF5555',
    green: '#50FA7B',
    yellow: '#F1FA8C',
    blue: '#BD93F9',
    magenta: '#FF79C6',
    cyan: '#8BE9FD',
    white: '#BBBBBB',
    brightBlack: '#555555',
    brightRed: '#FF5555',
    brightGreen: '#50FA7B',
    brightYellow: '#F1FA8C',
    brightBlue: '#CAA9FA',
    brightMagenta: '#FF79C6',
    brightCyan: '#8BE9FD',
    brightWhite: '#FFFFFF'
  },
  'phenomenon': {
    background: '#121212',
    foreground: '#FAF9F6',
    cursor: '#2E5D9E',
    cursorAccent: '#121212',
    selectionBackground: 'rgba(46, 93, 158, 0.280)',
    selectionForeground: '#FAF9F6',
    black: '#121212',
    red: '#D22D1E',
    green: '#1CA05A',
    yellow: '#E5A01A',
    blue: '#3780E9',
    magenta: '#BF409D',
    cyan: '#799C92',
    white: '#FAF9F6',
    brightBlack: '#292929',
    brightRed: '#AE756F',
    brightGreen: '#789B88',
    brightYellow: '#BD9F65',
    brightBlue: '#6F839F',
    brightMagenta: '#A57899',
    brightCyan: '#BFC5C3',
    brightWhite: '#FFFFFF'
  },
  'jellyfish': {
    background: '#1B1718',
    foreground: '#FFFFFF',
    cursor: '#538682',
    cursorAccent: '#1B1718',
    selectionBackground: 'rgba(83, 134, 130, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#616161',
    red: '#FF8272',
    green: '#B4FA72',
    yellow: '#FEFDC2',
    blue: '#A5D5FE',
    magenta: '#FF8FFD',
    cyan: '#D0D1FE',
    white: '#F1F1F1',
    brightBlack: '#8E8E8E',
    brightRed: '#FFC4BD',
    brightGreen: '#D6FCB9',
    brightYellow: '#FEFDD5',
    brightBlue: '#C1E3FE',
    brightMagenta: '#FFB1FE',
    brightCyan: '#E5E6FE',
    brightWhite: '#FEFFFF'
  },
  'koi': {
    background: '#211719',
    foreground: '#FFFFFF',
    cursor: '#FF3131',
    cursorAccent: '#211719',
    selectionBackground: 'rgba(255, 49, 49, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#616161',
    red: '#FF8272',
    green: '#B4FA72',
    yellow: '#FEFDC2',
    blue: '#A5D5FE',
    magenta: '#FF8FFD',
    cyan: '#D0D1FE',
    white: '#F1F1F1',
    brightBlack: '#8E8E8E',
    brightRed: '#FFC4BD',
    brightGreen: '#D6FCB9',
    brightYellow: '#FEFDD5',
    brightBlue: '#C1E3FE',
    brightMagenta: '#FFB1FE',
    brightCyan: '#E5E6FE',
    brightWhite: '#FEFFFF'
  },
  'leafy': {
    background: '#000000',
    foreground: '#FFFFFF',
    cursor: '#55972D',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(85, 151, 45, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#616161',
    red: '#FF8272',
    green: '#B4FA72',
    yellow: '#FEFDC2',
    blue: '#A5D5FE',
    magenta: '#FF8FFD',
    cyan: '#D0D1FE',
    white: '#F1F1F1',
    brightBlack: '#8E8E8E',
    brightRed: '#FFC4BD',
    brightGreen: '#D6FCB9',
    brightYellow: '#FEFDD5',
    brightBlue: '#C1E3FE',
    brightMagenta: '#FFB1FE',
    brightCyan: '#E5E6FE',
    brightWhite: '#FEFFFF'
  },
  'marble': {
    background: '#E3E3E3',
    foreground: '#000000',
    cursor: '#585858',
    cursorAccent: '#E3E3E3',
    selectionBackground: 'rgba(88, 88, 88, 0.280)',
    selectionForeground: '#000000',
    black: '#212121',
    red: '#C30771',
    green: '#10A778',
    yellow: '#A89C14',
    blue: '#008EC4',
    magenta: '#523C79',
    cyan: '#20A5BA',
    white: '#E0E0E0',
    brightBlack: '#212121',
    brightRed: '#FB007A',
    brightGreen: '#5FD7AF',
    brightYellow: '#F3E430',
    brightBlue: '#20BBFC',
    brightMagenta: '#6855DE',
    brightCyan: '#4FB8CC',
    brightWhite: '#F1F1F1'
  },
  'pink-city': {
    background: '#FBEFF6',
    foreground: '#000000',
    cursor: '#E10087',
    cursorAccent: '#FBEFF6',
    selectionBackground: 'rgba(225, 0, 135, 0.280)',
    selectionForeground: '#000000',
    black: '#212121',
    red: '#C30771',
    green: '#10A778',
    yellow: '#A89C14',
    blue: '#008EC4',
    magenta: '#523C79',
    cyan: '#20A5BA',
    white: '#E0E0E0',
    brightBlack: '#212121',
    brightRed: '#FB007A',
    brightGreen: '#5FD7AF',
    brightYellow: '#F3E430',
    brightBlue: '#20BBFC',
    brightMagenta: '#6855DE',
    brightCyan: '#4FB8CC',
    brightWhite: '#F1F1F1'
  },
  'snowy': {
    background: '#EEF2F5',
    foreground: '#000000',
    cursor: '#647E90',
    cursorAccent: '#EEF2F5',
    selectionBackground: 'rgba(100, 126, 144, 0.280)',
    selectionForeground: '#000000',
    black: '#212121',
    red: '#C30771',
    green: '#10A778',
    yellow: '#A89C14',
    blue: '#008EC4',
    magenta: '#523C79',
    cyan: '#20A5BA',
    white: '#E0E0E0',
    brightBlack: '#212121',
    brightRed: '#FB007A',
    brightGreen: '#5FD7AF',
    brightYellow: '#F3E430',
    brightBlue: '#20BBFC',
    brightMagenta: '#6855DE',
    brightCyan: '#4FB8CC',
    brightWhite: '#F1F1F1'
  },
  'red-rock': {
    background: '#262325',
    foreground: '#FFFFFF',
    cursor: '#9F4147',
    cursorAccent: '#262325',
    selectionBackground: 'rgba(159, 65, 71, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#616161',
    red: '#FF8272',
    green: '#B4FA72',
    yellow: '#FEFDC2',
    blue: '#A5D5FE',
    magenta: '#FF8FFD',
    cyan: '#D0D1FE',
    white: '#F1F1F1',
    brightBlack: '#8E8E8E',
    brightRed: '#FFC4BD',
    brightGreen: '#D6FCB9',
    brightYellow: '#FEFDD5',
    brightBlue: '#C1E3FE',
    brightMagenta: '#FFB1FE',
    brightCyan: '#E5E6FE',
    brightWhite: '#FEFFFF'
  },
  'dark-city': {
    background: '#0C2932',
    foreground: '#FFFFFF',
    cursor: '#E9072D',
    cursorAccent: '#0C2932',
    selectionBackground: 'rgba(233, 7, 45, 0.280)',
    selectionForeground: '#FFFFFF',
    black: '#616161',
    red: '#FF8272',
    green: '#B4FA72',
    yellow: '#FEFDC2',
    blue: '#A5D5FE',
    magenta: '#FF8FFD',
    cyan: '#D0D1FE',
    white: '#F1F1F1',
    brightBlack: '#8E8E8E',
    brightRed: '#FFC4BD',
    brightGreen: '#D6FCB9',
    brightYellow: '#FEFDD5',
    brightBlue: '#C1E3FE',
    brightMagenta: '#FFB1FE',
    brightCyan: '#E5E6FE',
    brightWhite: '#FEFFFF'
  },
  'solar-flare': {
    background: '#1B1C18',
    foreground: '#DDE6EE',
    cursor: '#34895C',
    cursorAccent: '#1B1C18',
    selectionBackground: 'rgba(52, 137, 92, 0.280)',
    selectionForeground: '#DDE6EE',
    black: '#2E333D',
    red: '#D66060',
    green: '#64AF86',
    yellow: '#CAA358',
    blue: '#5C80B2',
    magenta: '#B766A1',
    cyan: '#8069A1',
    white: '#F0F4F7',
    brightBlack: '#37404A',
    brightRed: '#EB8282',
    brightGreen: '#64AF86',
    brightYellow: '#CAA358',
    brightBlue: '#5C80B2',
    brightMagenta: '#B766A1',
    brightCyan: '#8069A1',
    brightWhite: '#FFFFFF'
  },
  'adeberry': {
    background: '#1D2022',
    foreground: '#E4EEF5',
    cursor: '#6C96B4',
    cursorAccent: '#1D2022',
    selectionBackground: 'rgba(108, 150, 180, 0.280)',
    selectionForeground: '#E4EEF5',
    black: '#121212',
    red: '#C76156',
    green: '#57C78A',
    yellow: '#C8A35A',
    blue: '#5785C7',
    magenta: '#C756A9',
    cyan: '#57C7C3',
    white: '#EEEDEB',
    brightBlack: '#292929',
    brightRed: '#D22D1E',
    brightGreen: '#1CA05A',
    brightYellow: '#E5A01A',
    brightBlue: '#1458B8',
    brightMagenta: '#A43787',
    brightCyan: '#4D9989',
    brightWhite: '#FFFFFF'
  }
}

export const STORAGE_KEY = 'tr-theme'

const OLD_GLOBAL_TERMINAL_DEFAULT: ThemeName = 'warm-espresso'
const AUTO_MIGRATION_GUARD_KEY = 'tr-theme-auto-migrated'

export function loadTheme(): TerminalPaletteChoice {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === AUTO_TERMINAL_PALETTE) return AUTO_TERMINAL_PALETTE
  if (THEMES.includes(saved as ThemeName)) {
    const savedTheme = saved as ThemeName
    if (
      savedTheme === OLD_GLOBAL_TERMINAL_DEFAULT &&
      localStorage.getItem(AUTO_MIGRATION_GUARD_KEY) === null
    ) {
      localStorage.setItem(AUTO_MIGRATION_GUARD_KEY, '1')
      localStorage.setItem(STORAGE_KEY, AUTO_TERMINAL_PALETTE)
      return AUTO_TERMINAL_PALETTE
    }
    return savedTheme
  }
  return AUTO_TERMINAL_PALETTE
}

export function saveTerminalPaletteChoice(choice: TerminalPaletteChoice): void {
  localStorage.setItem(STORAGE_KEY, choice)
}

export function applyTheme(theme: ThemeName): void {
  const background = TERMINAL_PALETTES[theme].background
  if (background) {
    void setBackgroundColor(background).catch((err: unknown) => {
      console.warn('houston: setBackgroundColor failed', err)
    })
  }
}
