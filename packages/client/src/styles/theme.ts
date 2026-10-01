import type { GlobalThemeOverrides } from 'naive-ui'
import {
  resolveThemeCustomization,
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
    borderRadius: '5px',
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
    borderRadius: '5px',
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
): GlobalThemeOverrides {
  const base = isDark ? darkThemeOverrides : lightThemeOverrides
  if (!isComic && !customization) return base
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

  return {
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
}
