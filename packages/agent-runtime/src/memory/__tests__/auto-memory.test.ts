import { describe, expect, test } from 'bun:test'

import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { getInitialAgentState } from '@codebuff/common/types/session-state'

import {
  extractFactCandidatesFromFrameBody,
  hydrateMemoryFrameForStep,
  MEMORY_FRAME_TAG,
} from '../auto-memory'

import type { AgentState } from '@codebuff/common/types/session-state'

function getMemoryFrameText(state: AgentState): string {
  const memoryMessage = state.messageHistory.find((message) =>
    message.tags?.includes(MEMORY_FRAME_TAG),
  )
  if (!memoryMessage || !Array.isArray(memoryMessage.content)) {
    return ''
  }
  const firstTextPart = memoryMessage.content.find(
    (part) => part.type === 'text',
  )
  return firstTextPart && typeof firstTextPart.text === 'string'
    ? firstTextPart.text
    : ''
}

describe('auto-memory frame hydration', () => {
  test('injects MEMORY_FRAME with thread id and memory summary', () => {
    const state = getInitialAgentState()
    state.messageHistory = [
      userMessage('Please fix the login bug and keep tests passing'),
      assistantMessage('I will inspect auth flow and then run tests'),
    ]

    const next = hydrateMemoryFrameForStep({
      agentState: state,
      prompt: undefined,
      maxTokens: 1200,
    })

    expect(next.memory).toBeDefined()
    expect(typeof next.memory?.threadId).toBe('string')
    expect(next.memory?.revision).toBeGreaterThan(0)

    const memoryMessages = next.messageHistory.filter((message) =>
      message.tags?.includes(MEMORY_FRAME_TAG),
    )
    expect(memoryMessages).toHaveLength(1)

    const memoryText = getMemoryFrameText(next)
    expect(memoryText).toContain('<memory_frame')
    expect(memoryText).toContain('[RECENT USER REQUESTS]')
    expect(memoryText).toContain('Please fix the login bug')
  })

  test('does not duplicate MEMORY_FRAME when hydrating repeatedly', () => {
    const state = getInitialAgentState()
    state.messageHistory = [userMessage('Refactor the parser carefully')]

    const first = hydrateMemoryFrameForStep({
      agentState: state,
      prompt: undefined,
    })
    const second = hydrateMemoryFrameForStep({
      agentState: first,
      prompt: undefined,
    })

    const memoryMessages = second.messageHistory.filter((message) =>
      message.tags?.includes(MEMORY_FRAME_TAG),
    )
    expect(memoryMessages).toHaveLength(1)
    expect(second.memory?.revision).toBeGreaterThanOrEqual(
      first.memory?.revision ?? 0,
    )
  })

  test('includes open todos from latest write_todos tool call', () => {
    const state = getInitialAgentState()
    state.messageHistory = [
      userMessage('Continue implementation'),
      assistantMessage({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'todos-1',
            toolName: 'write_todos',
            input: {
              todos: [
                { task: 'Add runtime hooks', completed: false },
                { task: 'Write docs', completed: true },
              ],
            },
          },
        ],
      }),
    ]

    const next = hydrateMemoryFrameForStep({
      agentState: state,
      prompt: undefined,
      maxTokens: 1200,
    })

    const memoryText = getMemoryFrameText(next)
    expect(memoryText).toContain('[OPEN TASKS]')
    expect(memoryText).toContain('Add runtime hooks')
    expect(memoryText).not.toContain('Write docs')
  })

  test('merges long-run persisted frame text into memory body', () => {
    const state = getInitialAgentState()
    state.memory = {
      threadId: 'thread-1',
      revision: 3,
      frameHash: 'abc123',
      persistedFrameText:
        '[CONSTRAINTS TO RESPECT]\n- Keep API backward-compatible\n- Never remove tests',
      pinnedFactIds: [],
      unresolvedConflictIds: [],
    }
    state.messageHistory = [userMessage('Ship this with no breaking changes')]

    const next = hydrateMemoryFrameForStep({
      agentState: state,
      prompt: undefined,
      maxTokens: 1200,
    })

    const memoryText = getMemoryFrameText(next)
    expect(memoryText).toContain('[LONG-RUN MEMORY]')
    expect(memoryText).toContain('Keep API backward-compatible')
    expect(memoryText).toContain('Never remove tests')
  })

  test('does not carry ephemeral retrieved/conflict sections into long-run memory', () => {
    const state = getInitialAgentState()
    state.memory = {
      threadId: 'thread-1',
      revision: 1,
      frameHash: 'abc123',
      persistedFrameText:
        '[LONG-RUN MEMORY]\n- Keep API stable\n\n[RETRIEVED FACTS]\n- Temporary retrieval line\n\n[HIGH-IMPACT CONFLICTS]\n- API version: "v1" vs "v2"\n\n[CONFLICT RESOLUTION LOG]\n- Auto-resolved 1 low-confidence contradictions',
      pinnedFactIds: [],
      unresolvedConflictIds: [],
    }
    state.messageHistory = [userMessage('Continue implementation')]

    const next = hydrateMemoryFrameForStep({
      agentState: state,
      prompt: undefined,
      maxTokens: 1200,
    })

    const memoryText = getMemoryFrameText(next)
    expect(memoryText).toContain('Keep API stable')
    expect(memoryText).not.toContain('Temporary retrieval line')
    expect(memoryText).not.toContain('API version: "v1" vs "v2"')
    expect(memoryText).not.toContain('Auto-resolved 1 low-confidence contradictions')
  })

  test('extracts fact candidates from memory frame body by section', () => {
    const facts = extractFactCandidatesFromFrameBody(
      `[CONSTRAINTS TO RESPECT]\n- Do not break API compatibility\n\n[OPEN TASKS]\n- Add regression tests`,
    )

    expect(facts.length).toBe(2)
    expect(facts[0]?.tags).toContain('constraint')
    expect(facts[1]?.tags).toContain('task')
    expect(facts[0]?.key).toContain('do not break api compatibility')
  })

  test('does not extract ephemeral conflict/retrieved sections as facts', () => {
    const facts = extractFactCandidatesFromFrameBody(
      `[RETRIEVED FACTS]\n- Prior fact\n\n[HIGH-IMPACT CONFLICTS]\n- API: A vs B\n\n[CONSTRAINTS TO RESPECT]\n- Keep tests stable`,
    )

    expect(facts).toHaveLength(1)
    expect(facts[0]?.content).toContain('Keep tests stable')
  })
})
