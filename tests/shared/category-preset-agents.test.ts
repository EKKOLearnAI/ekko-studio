import { describe, expect, it } from 'vitest'

import { SESSION_CATEGORY_PRESET_AGENTS } from '../../packages/server/src/modules/studio/services/session-category-preset'
import { AGENT_OPTIONS } from '../../packages/client/src/utils/agent-options'

describe('category preset agents', () => {
  it('server preset agent allowlist matches the New Chat drawer agent options', () => {
    // A preset agent the drawer cannot pick, or a drawer agent the server refuses,
    // would make a saved preset unusable or unsavable.
    expect(new Set(SESSION_CATEGORY_PRESET_AGENTS)).toEqual(new Set(AGENT_OPTIONS.map(option => option.value)))
  })
})
