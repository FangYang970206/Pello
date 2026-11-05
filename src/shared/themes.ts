import type { ThemeName } from './types'

type Palette = { bg: string; side: string; panel: string; elev: string; elev2: string; text: string; muted: string; faint: string; ctl: string; accent: string; ink: string; green: string; red: string; amber: string; blue: string; magenta: string; cyan: string }
export type WorkbenchTheme = { id: ThemeName; name: string; mode: 'dark' | 'light'; colors: Palette }
const dark: Palette = { bg: '#0c0d0f', side: '#131417', panel: '#16171a', elev: '#1c1d21', elev2: '#232429', text: '#e8e9ec', muted: '#adb2bd', faint: '#949aa6', ctl: '#686e7a', accent: '#8e96ff', ink: '#0c0d18', green: '#6fcf97', red: '#f07a7a', amber: '#e3b660', blue: '#7fb2ff', magenta: '#c99cf0', cyan: '#6fd0d6' }
const light: Palette = { bg: '#fcfcfd', side: '#f3f3f5', panel: '#f8f8fa', elev: '#ffffff', elev2: '#f1f1f4', text: '#1a1b1e', muted: '#565b65', faint: '#606672', ctl: '#8a8f99', accent: '#5355d1', ink: '#ffffff', green: '#187a42', red: '#b93434', amber: '#865b00', blue: '#2c64c4', magenta: '#8a45b8', cyan: '#0b7078' }

export const THEMES: WorkbenchTheme[] = [
  { id: 'dark', name: '深色', mode: 'dark', colors: dark },
  { id: 'light', name: '浅色', mode: 'light', colors: light },
  { id: 'nord', name: 'Nord', mode: 'dark', colors: { ...dark, bg: '#272e39', side: '#2e3440', panel: '#303744', elev: '#363f4f', elev2: '#3b4557', text: '#eceff4', muted: '#c0cad9', faint: '#b7c2d2', ctl: '#94a0b5', accent: '#88c0d0', ink: '#1c2934', green: '#a3be8c', red: '#ff8790', amber: '#ebcb8b', blue: '#a5c5ea', magenta: '#d5afd5', cyan: '#8fced0' } },
  { id: 'dracula', name: 'Dracula', mode: 'dark', colors: { ...dark, bg: '#20212c', side: '#21222c', panel: '#282a36', elev: '#303240', elev2: '#383a4a', text: '#f8f8f2', muted: '#c3bfd5', faint: '#b9b5ca', ctl: '#a1a0b5', accent: '#bd93f9', ink: '#221b2e', green: '#80e6a0', red: '#ff7c89', amber: '#f5dc8b', blue: '#9dbaff', magenta: '#ff9dda', cyan: '#8be9fd' } },
  { id: 'catppuccin', name: 'Catppuccin Mocha', mode: 'dark', colors: { ...dark, bg: '#181825', side: '#1e1e2e', panel: '#242436', elev: '#2b2b3f', elev2: '#34344b', text: '#cdd6f4', muted: '#bac2de', faint: '#b4bcd7', ctl: '#9aa2bd', accent: '#cba6f7', ink: '#211a30', green: '#a6e3a1', red: '#f38ba8', amber: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#89dceb' } },
  { id: 'solarized-light', name: 'Solarized Light', mode: 'light', colors: { ...light, bg: '#fdf6e3', side: '#eee8d5', panel: '#fffaf0', elev: '#fffdf7', elev2: '#e8e3d0', text: '#334d55', muted: '#52666c', faint: '#53696f', ctl: '#7b8b8d', accent: '#075e94', ink: '#ffffff', green: '#2f6f25', red: '#a52d31', amber: '#7b5300', blue: '#145d8b', magenta: '#994b82', cyan: '#096e76' } }
]
export function workbenchTheme(id: ThemeName): WorkbenchTheme { return THEMES.find((theme) => theme.id === id) || THEMES[0] }
export function themeVariables(id: ThemeName): Record<string, string> {
  const { colors } = workbenchTheme(id)
  return { ...Object.fromEntries(Object.entries(colors).filter(([key]) => key !== 'ink').map(([key, value]) => [`--${key}`, value])), '--accent-ink': colors.ink, '--accent-soft': `${colors.accent}24` }
}
