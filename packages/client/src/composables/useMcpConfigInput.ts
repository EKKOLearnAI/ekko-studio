import { onUnmounted, ref } from 'vue'
import yaml from 'js-yaml'

export type McpConfigInputMode = 'json' | 'yaml'

interface McpConfigInputMessages {
  invalidJson: () => string
  invalidYaml: (detail?: string) => string
  invalidConfig: () => string
}

interface McpConfigInputOptions {
  messages: McpConfigInputMessages
  validateServer: (name: string, config: unknown) => string | null
  formatDelay?: number
}

type ParseResult =
  | { data: Record<string, unknown>; error: '' }
  | { data: null; error: string }

export function formatMcpConfigInput(data: Record<string, unknown>, mode: McpConfigInputMode): string {
  return mode === 'json'
    ? JSON.stringify(data, null, 2)
    : yaml.dump(data, { indent: 2, lineWidth: -1 }).trimEnd()
}

/**
 * Shared JSON/YAML MCP editor behavior used by both Hermes and Ekko.
 * It intentionally keeps parsing, wrapper correction, formatting, and mode
 * conversion in one place so the two configuration screens cannot drift.
 */
export function useMcpConfigInput(options: McpConfigInputOptions) {
  const inputMode = ref<McpConfigInputMode>('json')
  const configText = ref('')
  const configError = ref('')
  let formatTimer: ReturnType<typeof setTimeout> | null = null

  function clearFormatTimer() {
    if (!formatTimer) return
    clearTimeout(formatTimer)
    formatTimer = null
  }

  function parseConfig(text: string, mode: McpConfigInputMode = inputMode.value): ParseResult {
    if (mode === 'json') {
      try {
        const data: unknown = JSON.parse(text)
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return { data: null, error: options.messages.invalidJson() }
        }
        return { data: data as Record<string, unknown>, error: '' }
      } catch {
        return { data: null, error: options.messages.invalidJson() }
      }
    }

    try {
      const data: unknown = yaml.load(text, { schema: yaml.JSON_SCHEMA })
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { data: null, error: options.messages.invalidYaml() }
      }
      return { data: data as Record<string, unknown>, error: '' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      return { data: null, error: options.messages.invalidYaml(detail) }
    }
  }

  function extractServers(data: Record<string, unknown> | null): {
    servers: Record<string, unknown>
    error: string
  } {
    if (!data) return { servers: {}, error: options.messages.invalidConfig() }

    // Accept the two common client config wrappers, then normalize the editor
    // back to the server map expected by Studio.
    if (data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers) && !data.command) {
      return { servers: data.mcpServers as Record<string, unknown>, error: '' }
    }
    if (data.mcp_servers && typeof data.mcp_servers === 'object' && !Array.isArray(data.mcp_servers) && !data.command) {
      return { servers: data.mcp_servers as Record<string, unknown>, error: '' }
    }
    return { servers: data, error: '' }
  }

  function parseAndValidate(text = configText.value): {
    servers: Record<string, unknown>
    error: string
  } {
    const parsed = parseConfig(text)
    if (parsed.error) return { servers: {}, error: parsed.error }

    const extracted = extractServers(parsed.data)
    if (extracted.error) return extracted
    if (!Object.keys(extracted.servers).length) {
      return { servers: {}, error: options.messages.invalidConfig() }
    }

    for (const [name, config] of Object.entries(extracted.servers)) {
      const error = options.validateServer(name, config)
      if (error) return { servers: {}, error }
    }
    return extracted
  }

  function handleInput(text: string) {
    clearFormatTimer()
    if (!text.trim()) {
      configError.value = ''
      return
    }

    const parsed = parseConfig(text)
    if (parsed.error || !parsed.data) {
      configError.value = parsed.error
      return
    }
    const extracted = extractServers(parsed.data)
    if (extracted.error) {
      configError.value = extracted.error
      return
    }

    configError.value = ''
    formatTimer = setTimeout(() => {
      formatTimer = null
      const formatted = formatMcpConfigInput(extracted.servers, inputMode.value)
      if (formatted !== text) configText.value = formatted
    }, options.formatDelay ?? 1500)
  }

  function handleModeChange(mode: McpConfigInputMode) {
    clearFormatTimer()
    if (!configText.value.trim()) return

    const previousMode: McpConfigInputMode = mode === 'json' ? 'yaml' : 'json'
    let parsed = parseConfig(configText.value, previousMode)
    if (parsed.error) parsed = parseConfig(configText.value, mode)
    if (parsed.error || !parsed.data) {
      configError.value = parsed.error
      return
    }

    configText.value = formatMcpConfigInput(parsed.data, mode)
    configError.value = ''
  }

  function setConfigText(data: Record<string, unknown>, mode: McpConfigInputMode = inputMode.value) {
    clearFormatTimer()
    configText.value = formatMcpConfigInput(data, mode)
    configError.value = ''
  }

  onUnmounted(clearFormatTimer)

  return {
    inputMode,
    configText,
    configError,
    clearFormatTimer,
    handleInput,
    handleModeChange,
    parseAndValidate,
    setConfigText,
  }
}
