// Native CLI identity is independent of its supported configuration modes.
export const NATIVE_CODING_AGENT_IDS = ['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'] as const
export type NativeCodingAgentId = typeof NATIVE_CODING_AGENT_IDS[number]

export function isNativeCodingAgent(value: unknown): value is NativeCodingAgentId {
  return typeof value === 'string' && (NATIVE_CODING_AGENT_IDS as readonly string[]).includes(value)
}

export function nativeCodingAgentSupportsScoped(value: unknown): value is Exclude<NativeCodingAgentId, 'qoder'> {
  return isNativeCodingAgent(value) && value !== 'qoder'
}

export function isGlobalOnlyCodingAgent(value: unknown): boolean {
  return value === 'cursor' || value === 'qoder'
}

export const NATIVE_CODING_AGENTS = [
  { id: 'qwen', name: 'Qwen Code', provider: 'Alibaba', command: 'qwen', packageName: '@qwen-code/qwen-code', docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/', acpArgs: ['--acp'] },
  { id: 'kimi', name: 'Kimi Code', provider: 'Moonshot AI', command: 'kimi', packageName: '@moonshot-ai/kimi-code', docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html', acpArgs: ['acp'] },
  { id: 'codebuddy', name: 'CodeBuddy', provider: 'Tencent', command: 'codebuddy', packageName: '@tencent-ai/codebuddy-code', docsUrl: 'https://www.codebuddy.ai/docs/cli/README', acpArgs: ['--acp'] },
  { id: 'qoder', name: 'Qoder', provider: 'Qoder', command: 'qoder', packageName: '@qoder-ai/qodercli', docsUrl: 'https://docs.qoder.com/cli/installation', acpArgs: ['--acp'] },
  { id: 'copilot', name: 'GitHub Copilot', provider: 'GitHub', command: 'copilot', packageName: '@github/copilot', docsUrl: 'https://docs.github.com/en/copilot/get-started/cli-quickstart', acpArgs: ['--acp'] },
  { id: 'zcode', name: 'ZCode', provider: 'Z.ai', command: 'zcode', packageName: '', docsUrl: 'https://github.com/zai-org/ZCode', acpArgs: [] },
] as const
