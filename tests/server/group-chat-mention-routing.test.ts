import { describe, expect, it } from 'vitest'
import {
  isAllAgentsMentioned,
  isAgentMentioned,
  isReservedMentionName,
  resolveMentionTargets,
  resolveStructuredMentionTargets,
  stripMentionRoutingTokens,
} from '../../packages/server/src/modules/studio/services/group-chat/mention-routing'

type TestAgent = { name: string; id?: string; agentId?: string; profile?: string }

const agents: TestAgent[] = [
  { name: 'Alice', id: 'socket-alice', agentId: 'agent-alice' },
  { name: 'Bob', id: 'socket-bob', agentId: 'agent-bob' },
  { name: 'Regex.Bot', id: 'socket-regex', agentId: 'agent-regex' },
]

describe('group chat mention routing', () => {
  it('reserves @all so it cannot be confused with a literal agent name', () => {
    expect(isReservedMentionName('all')).toBe(true)
    expect(isReservedMentionName(' ALL ')).toBe(true)
    expect(isReservedMentionName('Alice')).toBe(false)
  })

  it('recognizes @all as a standalone mention with safe boundaries', () => {
    expect(isAllAgentsMentioned('@all please compare notes')).toBe(true)
    expect(isAllAgentsMentioned('please compare notes @ALL')).toBe(true)
    expect(isAllAgentsMentioned('@all, compare notes')).toBe(true)
    expect(isAllAgentsMentioned('email user@all.example')).toBe(false)
    expect(isAllAgentsMentioned('@alligator should not notify everyone')).toBe(false)
    expect(isAllAgentsMentioned('prefix@all should not notify everyone')).toBe(false)
  })

  it('keeps exact agent mentions boundary-aware and regex-safe', () => {
    expect(isAgentMentioned('@Regex.Bot please review', 'Regex.Bot')).toBe(true)
    expect(isAgentMentioned('@RegexxBot should not match', 'Regex.Bot')).toBe(false)
    expect(isAgentMentioned('@Alice, please review', 'Alice')).toBe(true)
    expect(isAgentMentioned('mailto@Alice.example', 'Alice')).toBe(false)
  })

  it('treats CJK enumeration顿号 as a safe after-boundary', () => {
    expect(isAgentMentioned('与其他智能体（@Hermes、@Claude、@Codex、@OpenCode 等）协作', 'Hermes')).toBe(true)
    expect(isAgentMentioned('与其他智能体（@Hermes、@Claude、@Codex、@OpenCode 等）协作', 'Claude')).toBe(true)
    expect(isAgentMentioned('与其他智能体（@Hermes、@Claude、@Codex、@OpenCode 等）协作', 'Codex')).toBe(true)
    expect(isAgentMentioned('与其他智能体（@Hermes、@Claude、@Codex、@OpenCode 等）协作', 'OpenCode')).toBe(true)
  })

  it('routes mentions after CJK speaker prefixes, emoji, and punctuation', () => {
    expect(isAgentMentioned('hermes：@Bob 老板喊你，出来露个脸。', 'Bob')).toBe(true)
    expect(isAgentMentioned('老板喊你@Bob 出来露个脸。', 'Bob')).toBe(true)
    expect(isAgentMentioned('🤖@Bob 出来露个脸。', 'Bob')).toBe(true)
    expect(isAgentMentioned('(agent)@Bob 出来露个脸。', 'Bob')).toBe(true)
    expect(isAgentMentioned('mailto@Bob.example', 'Bob')).toBe(false)
  })

  it('routes @all to every room agent except the sender identity', () => {
    expect(resolveMentionTargets(agents, '@all summarize the options', 'socket-alice').map(a => a.name)).toEqual(['Bob', 'Regex.Bot'])
  })

  it('keeps same-name human senders routable because sender exclusion uses identity, not display name', () => {
    const sameNameAgents: TestAgent[] = [
      { name: 'test', id: 'socket-agent-test', agentId: 'agent-test' },
      { name: 'tt', id: 'socket-agent-tt', agentId: 'agent-tt' },
    ]

    expect(resolveMentionTargets(sameNameAgents, '@all can you talk to me?', 'human-test-user').map(a => a.name)).toEqual(['test', 'tt'])
    expect(resolveMentionTargets(sameNameAgents, '@test why no response?', 'human-test-user').map(a => a.name)).toEqual(['test'])
  })

  it('still excludes an agent from routing to itself when the sender identity matches that agent', () => {
    const sameNameAgents: TestAgent[] = [
      { name: 'test', id: 'socket-agent-test', agentId: 'agent-test' },
      { name: 'tt', id: 'socket-agent-tt', agentId: 'agent-tt' },
    ]

    expect(resolveMentionTargets(sameNameAgents, '@all compare plans', 'socket-agent-test').map(a => a.name)).toEqual(['tt'])
    expect(resolveMentionTargets(sameNameAgents, '@all compare plans', 'agent-test').map(a => a.name)).toEqual(['tt'])
    expect(resolveMentionTargets(sameNameAgents, '@test check yourself', 'socket-agent-test').map(a => a.name)).toEqual([])
  })

  it('routes explicit mentions without treating partial @all text as broadcast', () => {
    expect(resolveMentionTargets(agents, '@Bob and @Regex.Bot compare plans', 'socket-alice').map(a => a.name)).toEqual(['Bob', 'Regex.Bot'])
    expect(resolveMentionTargets(agents, '@alligator and @Bob compare plans', 'socket-alice').map(a => a.name)).toEqual(['Bob'])
  })

  it('handles prefix collisions and special-character agent names', () => {
    const specialAgents: TestAgent[] = [
      { name: 'Bob', id: 'socket-bob', agentId: 'agent-bob' },
      { name: 'Bobcat', id: 'socket-bobcat', agentId: 'agent-bobcat' },
      { name: 'C++', id: 'socket-cpp', agentId: 'agent-cpp' },
    ]

    expect(resolveMentionTargets(specialAgents, '@Bobcat inspect', 'human-1').map(a => a.name)).toEqual(['Bobcat'])
    expect(resolveMentionTargets(specialAgents, '@Bob inspect', 'human-1').map(a => a.name)).toEqual(['Bob'])
    expect(resolveMentionTargets(specialAgents, '@C++: inspect', 'human-1').map(a => a.name)).toEqual(['C++'])
  })

  it('ignores mentions inside a quoted message while preserving them as context', () => {
    const content = [
      '<quoted_message sender="Alice">',
      '@Bob please review this',
      '</quoted_message>',
      '',
      '@Regex.Bot what do you think?',
    ].join('\n')

    expect(resolveMentionTargets(agents, content, 'socket-alice').map(agent => agent.name)).toEqual(['Regex.Bot'])
    expect(stripMentionRoutingTokens(content, 'Regex.Bot')).toContain('@Bob please review this')
    expect(stripMentionRoutingTokens(content, 'Regex.Bot')).not.toContain('@Regex.Bot')
  })

  it('dedupes mixed @all and explicit mentions', () => {
    expect(resolveMentionTargets(agents, '@all @Bob compare plans', 'socket-alice').map(a => a.name)).toEqual(['Bob', 'Regex.Bot'])
  })

  it('routes only stable structured agent identities and never resolves display-name collisions', () => {
    const sameNameAgents: TestAgent[] = [
      { name: 'Alex', id: 'socket-agent-alex', agentId: 'agent-alex' },
      { name: 'Alex', id: 'socket-agent-alex-2', agentId: 'agent-alex-2' },
    ]

    expect(resolveStructuredMentionTargets(sameNameAgents, [
      { type: 'agent', participantId: 'agent-alex-2' },
    ], 'human-alex').map(agent => agent.agentId)).toEqual(['agent-alex-2'])
    expect(resolveStructuredMentionTargets(sameNameAgents, [
      { type: 'agent', participantId: 'missing-agent' },
    ], 'human-alex')).toEqual([])
    expect(resolveStructuredMentionTargets(sameNameAgents, [], 'human-alex')).toEqual([])
  })

  it('strips the broadcast token and this agent mention before routing to the model', () => {
    expect(stripMentionRoutingTokens('@all @Bob please review', 'Bob')).toBe('please review')
    expect(stripMentionRoutingTokens('@ALL, @Regex.Bot: please review', 'Regex.Bot')).toBe('please review')
    expect(stripMentionRoutingTokens('@all please review', 'all')).toBe('please review')
  })
})
