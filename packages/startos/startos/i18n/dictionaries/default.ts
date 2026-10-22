export const DEFAULT_LANG = 'en_US'
const dict = {
  'Web Interface': 0,
  'The web interface is ready': 1,
  'The web interface is not ready': 2,
  'Set Admin Password': 3,
  'Generate and apply a new password for the admin account.': 4,
  'Replaces the current admin password.': 5,
  'Login Credentials': 6,
  'Save this password, start the service, and sign in as admin.': 7,
  Username: 8,
  Password: 9,
  'Set the admin password before starting Ekko Studio.': 10,
  'Ekko Studio browser interface, API, and live chat.': 11,
} as const
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
