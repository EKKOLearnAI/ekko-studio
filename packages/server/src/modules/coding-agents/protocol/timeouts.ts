/** Accept only positive integer milliseconds that Node timers can represent. */
export function timeoutFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  // Overflowing Node timers fire almost immediately instead of waiting longer.
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback
}
