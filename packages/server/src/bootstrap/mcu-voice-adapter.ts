import { getActiveGlobalAgentServer } from '../modules/studio/public/global-agent'
import { configureMcuVoice } from '../modules/studio/public/mcu-voice'

configureMcuVoice({
  emitEvent: (payload, options) => (
    getActiveGlobalAgentServer()?.emitMcuEvent(payload, options) ?? false
  ),
  startChatTurn: input => {
    getActiveGlobalAgentServer()?.startMcuVoiceChatTurn(input)
  },
})
