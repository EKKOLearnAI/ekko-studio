import { describe, expect, it } from 'vitest'
import { resolveDesktopUpdateSource, validateTestUpdateUrl } from '../../packages/desktop/src/main/updater-source'

describe('independent desktop distribution', () => {
  it('uses the branded OSS and organization GitHub feeds', () => {
    expect(resolveDesktopUpdateSource({})).toEqual({
      channel: 'stable',
      url: 'https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui',
      fallbackUrl: 'https://github.com/tangledup-ai/hermes-web-ui/releases/latest/download',
    })
  })

  it('keeps test builds away from the production feeds', () => {
    expect(() => validateTestUpdateUrl('https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui')).toThrow(/production/)
    expect(() => validateTestUpdateUrl('https://github.com/tangledup-ai/hermes-web-ui/releases/latest/download')).toThrow(/production/)
    expect(validateTestUpdateUrl('https://updates.example.test/builds/test')).toBe('https://updates.example.test/builds/test/')
  })
})
