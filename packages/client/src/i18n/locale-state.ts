import { shallowRef } from 'vue'

// Synchronous locale access for shared UI helpers, including notifications.
export const uiLocale = shallowRef('en')
