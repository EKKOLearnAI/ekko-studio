import { resolveAppearance, THEME_FONTS } from './theme-appearance'
import type { GlobalThemeOverrides } from 'naive-ui'
import {
  mixHex,
  resolveThemeCustomization,
  toRgbComponents,
  type ThemeCustomization,
} from './theme-customization'

export const lightThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#333333',
    primaryColorHover: '#1a1a1a',
    primaryColorPressed: '#000000',
    primaryColorSuppl: '#333333',
    bodyColor: '#fafafa',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    inputColor: '#ffffff',
    actionColor: '#f0f0f0',
    textColorBase: '#1a1a1a',
    textColor1: '#1a1a1a',
    textColor2: '#666666',
    textColor3: '#999999',
    dividerColor: '#e0e0e0',
    borderColor: '#e0e0e0',
    hoverColor: 'rgba(0, 0, 0, 0.04)',
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontSize: '14px',
    fontSizeMedium: '14px',
    heightMedium: '36px',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontFamilyMono: 'JetBrains Mono, Fira Code, Consolas, monospace',
  },
  Layout: {
    color: '#fafafa',
    siderColor: '#f5f5f5',
    headerColor: '#fafafa',
  },
  Menu: {
    itemTextColorActive: '#1a1a1a',
    itemTextColorActiveHover: '#1a1a1a',
    itemTextColorChildActive: '#1a1a1a',
    itemIconColorActive: '#1a1a1a',
    itemIconColorActiveHover: '#000000',
    itemColorActive: 'rgba(0, 0, 0, 0.06)',
    itemColorActiveHover: 'rgba(0, 0, 0, 0.1)',
    arrowColorActive: '#1a1a1a',
  },
  Button: {
    textColorPrimary: '#ffffff',
    colorPrimary: '#333333',
    colorHoverPrimary: '#1a1a1a',
    colorPressedPrimary: '#000000',
  },
  Input: {
    color: '#ffffff',
    colorFocus: '#ffffff',
    border: '1px solid #e0e0e0',
    borderHover: '1px solid #999999',
    borderFocus: '1px solid #333333',
    borderDisabled: '1px solid #ebebeb',
    groupLabelBorder: '1px solid #e0e0e0',
    placeholderColor: '#999999',
    caretColor: '#1a1a1a',
  },
  InternalSelection: {
    border: '1px solid #e0e0e0',
    borderHover: '1px solid #999999',
    borderActive: '1px solid #333333',
    borderFocus: '1px solid #333333',
  },
  Card: {
    color: '#ffffff',
    borderColor: '#e0e0e0',
  },
  Modal: {
    color: '#ffffff',
  },
  Drawer: {
    color: 'var(--bg-main-surface)',
    borderRadius: '0px',
    closeBorderRadius: '5px',
    closeColorHover: 'transparent',
    closeColorPressed: 'transparent',
  },
  Tag: {
    borderRadius: '6px',
  },
}

export const darkThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#e0e0e0',
    primaryColorHover: '#f5f5f5',
    primaryColorPressed: '#ffffff',
    primaryColorSuppl: '#e0e0e0',
    bodyColor: '#1a1a1a',
    cardColor: '#2a2a2a',
    modalColor: '#2a2a2a',
    popoverColor: '#2a2a2a',
    tableColor: '#2a2a2a',
    inputColor: '#2a2a2a',
    actionColor: '#252525',
    textColorBase: '#e0e0e0',
    textColor1: '#e0e0e0',
    textColor2: '#a0a0a0',
    textColor3: '#666666',
    dividerColor: '#3a3a3a',
    borderColor: '#3a3a3a',
    hoverColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontSize: '14px',
    fontSizeMedium: '14px',
    heightMedium: '36px',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontFamilyMono: 'JetBrains Mono, Fira Code, Consolas, monospace',
  },
  Layout: {
    color: '#1a1a1a',
    siderColor: '#202020',
    headerColor: '#1a1a1a',
  },
  Menu: {
    itemTextColorActive: '#e0e0e0',
    itemTextColorActiveHover: '#e0e0e0',
    itemTextColorChildActive: '#e0e0e0',
    itemIconColorActive: '#e0e0e0',
    itemIconColorActiveHover: '#ffffff',
    itemColorActive: 'rgba(255, 255, 255, 0.08)',
    itemColorActiveHover: 'rgba(255, 255, 255, 0.12)',
    arrowColorActive: '#e0e0e0',
  },
  Button: {
    textColorPrimary: '#1a1a1a',
    colorPrimary: '#e0e0e0',
    colorHoverPrimary: '#f5f5f5',
    colorPressedPrimary: '#ffffff',
  },
  Input: {
    color: '#2a2a2a',
    colorFocus: '#2a2a2a',
    border: '1px solid #555555',
    borderHover: '1px solid #777777',
    borderFocus: '1px solid #e0e0e0',
    borderDisabled: '1px solid #3a3a3a',
    groupLabelBorder: '1px solid #555555',
    placeholderColor: '#666666',
    caretColor: '#e0e0e0',
  },
  InternalSelection: {
    border: '1px solid #555555',
    borderHover: '1px solid #777777',
    borderActive: '1px solid #e0e0e0',
    borderFocus: '1px solid #e0e0e0',
  },
  Card: {
    color: '#2a2a2a',
    borderColor: '#3a3a3a',
  },
  Modal: {
    color: '#2a2a2a',
  },
  Drawer: {
    color: 'var(--bg-main-surface)',
    borderRadius: '0px',
    closeBorderRadius: '5px',
    closeColorHover: 'transparent',
    closeColorPressed: 'transparent',
  },
  Tag: {
    borderRadius: '6px',
  },
  Switch: {
    railColor: '#3a3a3a',
    railColorActive: '#e0e0e0',
    loadingColor: '#e0e0e0',
    opacityDisabled: 0.4,
  },
}

export function getThemeOverrides(
  isDark: boolean,
  isComic?: boolean,
  customization?: ThemeCustomization,
  hasCustomBackground = false,
): GlobalThemeOverrides {
  const base = isDark ? darkThemeOverrides : lightThemeOverrides
  if (!isComic && !customization && !hasCustomBackground) return base
  const comicFont = "'Comic Neue', 'ZCOOL KuaiLe', 'Zen Maru Gothic', 'Gaegu', cursive, sans-serif"
  const custom = customization ? resolveThemeCustomization(customization, isDark) : null
  const common = {
    ...base.common!,
    ...(isComic ? { fontFamily: comicFont } : {}),
    ...(custom ? {
      fontSize: `${custom.fontSize}px`,
      fontSizeMedium: `${custom.fontSize}px`,
    } : {}),
    ...(custom?.textPrimary ? {
      textColorBase: custom.textPrimary,
      textColor1: custom.textPrimary,
      textColor2: custom.textSecondary,
      textColor3: custom.textMuted,
    } : {}),
    ...(custom?.accentPrimary ? {
      primaryColor: custom.accentPrimary,
      primaryColorHover: custom.accentHover,
      primaryColorPressed: custom.accentHover,
      primaryColorSuppl: custom.accentPrimary,
    } : {}),
  }
  const input = custom?.textPrimary || custom?.accentPrimary
    ? {
        ...base.Input,
        ...(custom?.textPrimary ? {
          textColor: custom.textPrimary,
          placeholderColor: custom.textMuted,
          caretColor: custom.textPrimary,
        } : {}),
        ...(custom?.accentPrimary && custom.accentPrimaryRgb ? {
          border: `1px solid rgba(${custom.accentPrimaryRgb}, 0.18)`,
          borderHover: `1px solid rgba(${custom.accentPrimaryRgb}, 0.32)`,
          borderFocus: `1px solid ${custom.accentPrimary}`,
          groupLabelBorder: `1px solid rgba(${custom.accentPrimaryRgb}, 0.18)`,
        } : {}),
      }
    : null
  const internalSelection = custom?.textPrimary || custom?.accentPrimary
    ? {
        ...base.InternalSelection,
        ...(custom?.textPrimary ? {
          textColor: custom.textPrimary,
          placeholderColor: custom.textMuted,
          placeholderColorDisabled: custom.textMuted,
          caretColor: custom.textPrimary,
        } : {}),
        ...(custom?.accentPrimary && custom.accentPrimaryRgb ? {
          border: `1px solid rgba(${custom.accentPrimaryRgb}, 0.18)`,
          borderHover: `1px solid rgba(${custom.accentPrimaryRgb}, 0.32)`,
          borderActive: `1px solid ${custom.accentPrimary}`,
          borderFocus: `1px solid ${custom.accentPrimary}`,
          boxShadowActive: `0 0 0 2px rgba(${custom.accentPrimaryRgb}, 0.2)`,
          boxShadowFocus: `0 0 0 2px rgba(${custom.accentPrimaryRgb}, 0.2)`,
          loadingColor: custom.accentPrimary,
        } : {}),
      }
    : null

  const result: GlobalThemeOverrides = {
    ...base,
    common,
    ...(input ? { Input: input } : {}),
    ...(internalSelection ? { InternalSelection: internalSelection } : {}),
    ...(custom?.accentPrimary ? {
      Button: {
        ...base.Button,
        textColorPrimary: custom.textOnAccent,
        colorPrimary: custom.accentPrimary,
        colorHoverPrimary: custom.accentHover,
        colorPressedPrimary: custom.accentHover,
      },
      Switch: {
        ...base.Switch,
        railColorActive: custom.accentPrimary,
        loadingColor: custom.accentPrimary,
        boxShadowFocus: custom.accentPrimaryRgb
          ? `0 0 0 2px rgba(${custom.accentPrimaryRgb}, 0.3)`
          : base.Switch?.boxShadowFocus,
      },
    } : {}),
  }
  const resolved = resolveAppearance(customization || { fontSize: 14, textColor: null, accentColor: null }, isDark, isComic)
  const global = resolved.appearance.global
  if (custom?.textPrimary || custom?.accentPrimary) {
    result.Menu = {
      ...result.Menu,
      itemTextColorActive: resolved.accent,
      itemTextColorActiveHover: resolved.accent,
      itemTextColorChildActive: resolved.accent,
      itemIconColorActive: resolved.accent,
      itemIconColorActiveHover: resolved.accent,
      arrowColorActive: resolved.accent,
    }
  }
  result.common = {
    ...result.common,
    ...(custom ? {
      fontSizeMini: `${custom.fontSize * 12 / 14}px`,
      fontSizeTiny: `${custom.fontSize * 12 / 14}px`,
      fontSizeSmall: `${custom.fontSize * 14 / 14}px`,
      fontSizeLarge: `${custom.fontSize * 15 / 14}px`,
      fontSizeHuge: `${custom.fontSize * 16 / 14}px`,
    } : {}),
    ...(global.backgroundColor ? {
      bodyColor: resolved.background, cardColor: resolved.card, modalColor: resolved.card,
      popoverColor: resolved.card, inputColor: resolved.card, tableColor: resolved.card,
      actionColor: resolved.variables['--bg-secondary'],
    } : {}),
    ...(global.secondaryTextColor ? { textColor2: global.secondaryTextColor } : {}),
    ...(global.mutedTextColor ? { textColor3: global.mutedTextColor, placeholderColor: global.mutedTextColor } : {}),
    ...(global.borderColor || global.opacity !== undefined ? {
      borderColor: resolved.variables['--theme-global-border'], dividerColor: resolved.variables['--theme-global-border'],
    } : {}),
    ...(global.radius !== undefined ? { borderRadius: `${global.radius}px`, borderRadiusSmall: `${global.radius * 0.75}px` } : {}),
    ...(global.fontFamily ? { fontFamily: THEME_FONTS[global.fontFamily] } : {}),
    ...(global.controlHeight !== undefined ? {
      heightMedium: `${global.controlHeight}px`, heightSmall: `${global.controlHeight - 4}px`,
      heightLarge: `${global.controlHeight + 4}px`, heightTiny: `${global.controlHeight - 8}px`,
    } : {}),
    ...(global.lineHeight !== undefined ? { lineHeight: String(global.lineHeight) } : {}),
  }
  const surface = (region: 'card' | 'input' | 'overlay') => {
    const prefix = `--theme-${region}`
    return {
      ...(resolved.variables[`${prefix}-bg`] ? { color: resolved.variables[`${prefix}-bg`] } : {}),
      ...(resolved.variables[`${prefix}-radius`] ? { borderRadius: resolved.variables[`${prefix}-radius`] } : {}),
      ...(resolved.variables[`${prefix}-border`] ? { borderColor: resolved.variables[`${prefix}-border`] } : {}),
      ...(resolved.variables[`${prefix}-shadow`] ? { boxShadow: resolved.variables[`${prefix}-shadow`] } : {}),
    }
  }
  result.Card = { ...result.Card, ...surface('card') }
  const cardSurface = surface('card')
  const cardBackground = cardSurface.color || (hasCustomBackground ? 'rgba(var(--bg-card-rgb), 0.72)' : undefined)
  result.Tag = {
    ...result.Tag,
    // Default tags have separate fills for bordered and borderless variants.
    // Leave semantic and checkable-state colors to Naive UI.
    ...(cardBackground ? { color: cardBackground, colorBordered: cardBackground } : {}),
    ...(cardSurface.borderColor || global.borderWidth !== undefined ? {
      border: `${global.borderWidth ?? 1}px solid ${cardSurface.borderColor || resolved.border}`,
    } : {}),
  }
  result.Descriptions = {
    ...result.Descriptions,
    ...(cardBackground ? {
      tdColor: cardBackground, tdColorModal: cardBackground, tdColorPopover: cardBackground,
      // The wrapper owns the surface; headers add only a translucent tint.
      thColor: 'rgba(var(--text-primary-rgb), 0.04)',
      thColorModal: 'rgba(var(--text-primary-rgb), 0.04)',
      thColorPopover: 'rgba(var(--text-primary-rgb), 0.04)',
    } : {}),
    ...(cardSurface.borderRadius ? { borderRadius: cardSurface.borderRadius } : {}),
    ...(cardSurface.borderColor ? {
      borderColor: cardSurface.borderColor,
      borderColorModal: cardSurface.borderColor,
      borderColorPopover: cardSurface.borderColor,
    } : {}),
  }
  // Naive composites table states into opaque colors. Paint the surface once on
  // the wrapper and let cells add only a state tint, including in modal/popover tables.
  const tableSurface = {
    ...(cardBackground ? {
      tdColor: 'transparent', tdColorModal: 'transparent', tdColorPopover: 'transparent',
      thColor: 'rgba(var(--text-primary-rgb), 0.04)',
      thColorModal: 'rgba(var(--text-primary-rgb), 0.04)',
      thColorPopover: 'rgba(var(--text-primary-rgb), 0.04)',
      tdColorStriped: 'rgba(var(--text-primary-rgb), 0.025)',
      tdColorStripedModal: 'rgba(var(--text-primary-rgb), 0.025)',
      tdColorStripedPopover: 'rgba(var(--text-primary-rgb), 0.025)',
    } : {}),
    ...(cardSurface.borderRadius ? { borderRadius: cardSurface.borderRadius } : {}),
    ...(cardSurface.borderColor ? {
      borderColor: cardSurface.borderColor, borderColorModal: cardSurface.borderColor,
      borderColorPopover: cardSurface.borderColor,
    } : {}),
  }
  result.Table = { ...result.Table, ...tableSurface }
  result.DataTable = { ...result.DataTable, ...tableSurface,
    ...(cardBackground ? {
      tdColorHover: 'rgba(var(--text-primary-rgb), 0.08)',
      tdColorHoverModal: 'rgba(var(--text-primary-rgb), 0.08)',
      tdColorHoverPopover: 'rgba(var(--text-primary-rgb), 0.08)',
      tdColorSorting: 'rgba(var(--text-primary-rgb), 0.04)',
      tdColorSortingModal: 'rgba(var(--text-primary-rgb), 0.04)',
      tdColorSortingPopover: 'rgba(var(--text-primary-rgb), 0.04)',
      thColorHover: 'rgba(var(--text-primary-rgb), 0.08)',
      thColorHoverModal: 'rgba(var(--text-primary-rgb), 0.08)',
      thColorHoverPopover: 'rgba(var(--text-primary-rgb), 0.08)',
      thColorSorting: 'rgba(var(--text-primary-rgb), 0.08)',
      thColorSortingModal: 'rgba(var(--text-primary-rgb), 0.08)',
      thColorSortingPopover: 'rgba(var(--text-primary-rgb), 0.08)',
    } : {}),
    ...(cardSurface.borderColor ? { actionDividerColor: cardSurface.borderColor } : {}),
  }
  result.Modal = { ...result.Modal, ...surface('overlay') }
  result.Drawer = { ...result.Drawer, ...surface('overlay'), borderRadius: '0px' }
  // Popover is also Tooltip's peer. Scope its surface to non-tooltip DOM nodes
  // in _theme-surfaces.scss so inverted tooltip colors remain readable.
  result.Dropdown = { ...result.Dropdown, ...surface('overlay') }
  result.Dialog = { ...result.Dialog, ...surface('overlay') }
  result.Notification = { ...result.Notification, ...surface('overlay') }
  const overlayBorder = resolved.variables['--theme-overlay-border']
  if (overlayBorder) {
    const border = `${global.borderWidth ?? 1}px solid ${overlayBorder}`
    result.Drawer = { ...result.Drawer, headerBorderBottom: border, footerBorderTop: border }
    result.Popover = { ...result.Popover, dividerColor: overlayBorder }
    result.Dropdown = { ...result.Dropdown, dividerColor: overlayBorder }
    result.Dialog = { ...result.Dialog, border }
  }
  result.Input = { ...result.Input, ...surface('input'),
    ...(resolved.variables['--theme-input-bg'] ? { colorFocus: resolved.variables['--theme-input-bg'] } : {}),
    ...(global.mutedTextColor ? { placeholderColor: global.mutedTextColor } : {}),
  }
  result.InternalSelection = { ...result.InternalSelection, ...surface('input'),
    ...(resolved.variables['--theme-input-bg'] ? {
      colorActive: resolved.variables['--theme-input-bg'],
      colorFocus: resolved.variables['--theme-input-bg'],
    } : {}),
  }
  if (hasCustomBackground || resolved.variables['--theme-input-bg']) {
    const opacity = resolved.regions.input.opacity ?? (resolved.variables['--theme-input-bg'] ? 1 : 0.72)
    // Tint the inactive track so its white thumb remains visible on light fills.
    const neutral = mixHex(resolved.text, resolved.regions.input.backgroundColor, 0.12)
    result.Switch = {
      ...result.Switch,
      railColor: `rgba(${toRgbComponents(neutral)}, ${opacity})`,
      railColorActive: `rgba(${toRgbComponents(resolved.accent)}, ${opacity})`,
    }
  }
  if (global.borderWidth !== undefined || resolved.variables['--theme-input-border']) {
    const width = global.borderWidth ?? 1
    const border = `${width}px solid ${resolved.variables['--theme-input-border'] || resolved.regions.input.borderColor}`
    const activeBorder = `${width}px solid ${resolved.accent}`
    result.Input = { ...result.Input, border, borderHover: border, borderDisabled: border, borderFocus: activeBorder, groupLabelBorder: border }
    result.InternalSelection = { ...result.InternalSelection, border, borderHover: border, borderActive: activeBorder, borderFocus: activeBorder }
  }
  if (global.radius !== undefined) result.Tag = { ...result.Tag, borderRadius: `${global.radius * 0.75}px` }
  if (global.backgroundColor) result.Layout = { ...result.Layout, color: resolved.background, siderColor: resolved.background, headerColor: resolved.background }
  return result
}
