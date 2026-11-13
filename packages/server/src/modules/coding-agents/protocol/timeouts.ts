/** Accept only positive integer milliseconds that Node timers can represent. */
export function timeoutFromEnv(name: string, legacyName: string, fallback: number): number {
  // An invalid Studio override must not hide a valid legacy deployment setting.
  for (const key of [name, legacyName]) {
    const value = Number(process.env[key])
    // Overflowing Node timers fire almost immediately instead of waiting longer.
    if (Number.isInteger(value) && value > 0 && value <= 2_147_483_647) return value
  }
  return fallback
}
