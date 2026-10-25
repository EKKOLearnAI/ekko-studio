// Shared wire adapters used by both legacy CLI proxies and plugin Run gateways.
export { AnthropicStreamEvent, openAiChatSseToAnthropicEvents, openAiResponsesSseToAnthropicEvents } from '../services/models/protocol/adapters/anthropic-stream'
export { AnthropicAdapterTarget, AnthropicToolInputSchemas, createAnthropicToolInputSchemas, normalizeAnthropicToolArguments, shouldPreserveReasoningContent, anthropicToOpenAiChat, anthropicToOpenAiResponses, mapStopReason, openAiToAnthropicMessage, openAiResponsesToAnthropicMessage } from '../services/models/protocol/adapters/anthropic'
export { chatCompletionsToResponses, responsesToChatCompletion, responsesToChatCompletionSse } from '../services/models/protocol/adapters/chat-completions'
export { anthropicImageSourceToUrl, openAiImageUrl, imageUrlToAnthropicSource } from '../services/models/protocol/adapters/multimodal'
export { ResponsesStreamAdapterTarget, CanonicalResponsesEvent, normalizeResponsesSseEvents, openAiChatSseToResponsesEvents, openAiResponsesSseToResponsesEvents, anthropicMessagesSseToResponsesEvents } from '../services/models/protocol/adapters/responses-stream'
export { ResponsesAdapterTarget, stripHistoricalResponsesInlineImages, truncateResponsesToolOutputs, responseToolNamespaceForName, normalizeResponseFunctionCall, targetReasoningEffort, responsesToOpenAiChat, responsesToAnthropicMessages, openAiChatToResponses, anthropicMessageToResponses } from '../services/models/protocol/adapters/responses'
export * from '../services/models/protocol/sse'
