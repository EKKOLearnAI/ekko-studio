import {
  createDiscreteApi,
  darkTheme,
  type ConfigProviderProps,
  type MessageApi,
  type NotificationApi,
} from 'naive-ui'
import { useTheme } from '@/composables/useTheme'
import { getThemeOverrides } from '@/styles/theme'

type DiscreteFeedbackApis = {
  message: MessageApi
  notification: NotificationApi
}

let cachedApis: DiscreteFeedbackApis | null = null
let cachedThemeKey = ''

function themeKey(): string {
  const theme = useTheme()
  return JSON.stringify([theme.isDark.value, theme.isComic.value, theme.customization.value, theme.hasCustomBackground.value])
}

function discreteConfig(): { configProviderProps: ConfigProviderProps } {
  const theme = useTheme()
  return {
    configProviderProps: {
      theme: theme.isDark.value ? darkTheme : null,
      themeOverrides: getThemeOverrides(theme.isDark.value, theme.isComic.value, theme.customization.value, theme.hasCustomBackground.value),
    },
  }
}

function ensureDiscreteApis(): DiscreteFeedbackApis {
  const nextThemeKey = themeKey()
  if (!cachedApis || cachedThemeKey !== nextThemeKey) {
    const { message, notification } = createDiscreteApi(['message', 'notification'], discreteConfig())
    cachedApis = { message, notification }
    cachedThemeKey = nextThemeKey
  }
  return cachedApis
}

export function useMessage(): MessageApi {
  return ensureDiscreteApis().message
}

export function useNotification(): NotificationApi {
  return ensureDiscreteApis().notification
}
