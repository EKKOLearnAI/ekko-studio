export const USAGE_TOKEN_COLORS = {
  input: '#5c6bc0',
  output: '#26a69a',
  cache: '#f6ad55',
} as const

export function formatUsageTokens(value: number, locale = 'en'): string {
  const scale = value >= 1_000_000_000 ? { divisor: 1_000_000_000, digits: 2, suffix: 'B' }
    : value >= 1_000_000 ? { divisor: 1_000_000, digits: 2, suffix: 'M' }
      : value >= 1_000 ? { divisor: 1_000, digits: 1, suffix: 'K' }
        : { divisor: 1, digits: 0, suffix: '' }
  const amount = value / scale.divisor
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: scale.digits, maximumFractionDigits: scale.digits, useGrouping: false,
    }).format(amount) + scale.suffix
  } catch {
    return amount.toFixed(scale.digits) + scale.suffix
  }
}

export function formatUsagePercent(value: number, locale = 'en'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 100)
  } catch {
    return `${value.toFixed(1)}%`
  }
}
