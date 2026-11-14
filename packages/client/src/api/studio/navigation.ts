import { request } from '../client'
import type { NavigationSettings } from '../../../../shared/navigation-settings'

export const getNavigationSettings = () => request<NavigationSettings>('/api/navigation')
export const saveNavigationSettings = (settings: NavigationSettings) => request<NavigationSettings>('/api/navigation', { method: 'PUT', body: JSON.stringify(settings) })
