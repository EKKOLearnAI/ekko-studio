import type { ITheme } from '@xterm/xterm'
import type { ThemeCustomization } from './theme-customization'
import { toRgbComponents } from './theme-customization'
import { resolveAppearance } from './theme-appearance'

/** Canvas-based components cannot inherit CSS variables from their parent. */
export function terminalTheme(customization: ThemeCustomization, dark: boolean): ITheme {
  const theme = resolveAppearance(customization, dark)
  return {
    background: theme.variables['--theme-content-bg'] || theme.background,
    foreground: theme.text,
    cursor: theme.accent,
    cursorAccent: theme.background,
    selectionBackground: `rgba(${toRgbComponents(theme.accent)}, 0.3)`,
    black: dark ? '#1a1a1a' : '#333333', red: '#c94c4c', green: '#578b38',
    yellow: '#aa7c16', blue: '#3979bd', magenta: '#a355b0', cyan: '#2b8b92',
    white: dark ? '#d0d0d0' : '#bbbbbb', brightBlack: '#888888',
    brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
    brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  }
}

export function editorTheme(customization: ThemeCustomization, dark: boolean) {
  const theme = resolveAppearance(customization, dark)
  const content = theme.regions.content
  const alpha = Math.round((content.opacity ?? 1) * 255).toString(16).padStart(2, '0')
  return {
    base: dark ? 'vs-dark' as const : 'vs' as const,
    inherit: true,
    rules: [],
    colors: {
      'editor.background': `${content.backgroundColor}${alpha}`,
      'editor.foreground': theme.text,
      'editorLineNumber.foreground': theme.muted,
      'editorLineNumber.activeForeground': theme.secondary,
      'editorCursor.foreground': theme.accent,
      'editor.selectionBackground': `${theme.accent}40`,
      'editor.inactiveSelectionBackground': `${theme.accent}20`,
      'editorWidget.background': theme.regions.overlay.backgroundColor,
      'editorWidget.border': theme.regions.overlay.borderColor,
      'editorWidget.foreground': theme.text,
    },
  }
}
