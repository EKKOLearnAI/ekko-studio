import {
  arDZ,
  dateArDZ,
  dateDeDE,
  dateEnUS,
  dateEsAR,
  dateFrFR,
  dateJaJP,
  dateKoKR,
  datePtBR,
  dateRuRU,
  dateTrTR,
  dateZhCN,
  dateZhTW,
  deDE,
  enUS,
  esAR,
  frFR,
  jaJP,
  koKR,
  ptBR,
  ruRU,
  trTR,
  zhCN,
  zhTW,
  type NDateLocale,
  type NLocale,
} from 'naive-ui'

type NaiveLocaleConfig = {
  locale: NLocale
  dateLocale: NDateLocale
}

const LOCALE_CONFIGS: Record<string, NaiveLocaleConfig> = {
  en: { locale: enUS, dateLocale: dateEnUS },
  zh: { locale: zhCN, dateLocale: dateZhCN },
  'zh-tw': { locale: zhTW, dateLocale: dateZhTW },
  ja: { locale: jaJP, dateLocale: dateJaJP },
  ko: { locale: koKR, dateLocale: dateKoKR },
  de: { locale: deDE, dateLocale: dateDeDE },
  fr: { locale: frFR, dateLocale: dateFrFR },
  es: { locale: esAR, dateLocale: dateEsAR },
  pt: { locale: ptBR, dateLocale: datePtBR },
  ru: { locale: ruRU, dateLocale: dateRuRU },
  tr: { locale: trTR, dateLocale: dateTrTR },
  ar: { locale: arDZ, dateLocale: dateArDZ },
}

export function naiveLocaleFor(locale: string): NaiveLocaleConfig {
  const normalized = locale.trim().toLowerCase().replace(/_/g, '-')
  if (normalized === 'zh-tw' || normalized.startsWith('zh-hk')) {
    return LOCALE_CONFIGS['zh-tw']
  }
  return LOCALE_CONFIGS[normalized] || LOCALE_CONFIGS[normalized.split('-')[0]] || LOCALE_CONFIGS.en
}
