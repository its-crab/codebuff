import { userMessage } from '@codebuff/common/util/messages'

import { parseUserMessage, withSystemTags } from '../util/messages'

import type { AgentState, MemoryState } from '@codebuff/common/types/session-state'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export const MEMORY_FRAME_TAG = 'MEMORY_FRAME'

export type MemoryFactCandidate = {
  key: string
  content: string
  confidence: number
  weight: number
  tags: string[]
}

type TodoInput = {
  todos?: Array<{ task?: string; completed?: boolean }>
}

function createThreadId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function ensureMemoryState(memory: MemoryState | undefined): MemoryState {
  if (memory) {
    return memory
  }
  return {
    threadId: createThreadId(),
    revision: 0,
    pinnedFactIds: [],
    unresolvedConflictIds: [],
  }
}

function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function dedupeAndLimit(items: string[], maxItems: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const normalized = normalizeLine(item)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length >= maxItems) {
      break
    }
  }
  return result
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  return `${value.slice(0, maxChars - 3)}...`
}

function normalizeFactKey(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.slice(0, 160)
}

function getMessageText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  if (!Array.isArray(message.content)) {
    return ''
  }

  const textParts: string[] = []
  for (const part of message.content) {
    if (part.type !== 'text') continue
    if (!('text' in part) || typeof part.text !== 'string') continue

    const parsed = parseUserMessage(part.text)
    textParts.push(parsed ?? part.text)
  }
  return textParts.join('\n')
}

function isSummaryMessage(message: Message): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some(
      (part) =>
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.includes('<conversation_summary>'),
    )
  )
}

function isMemoryFrameMessage(message: Message): boolean {
  return !!message.tags?.includes(MEMORY_FRAME_TAG)
}

function collectRecentUserRequests(
  messages: Message[],
  prompt: string | undefined,
): string[] {
  const requests: string[] = []
  if (prompt?.trim()) {
    requests.push(prompt.trim())
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    if (isSummaryMessage(message)) continue

    const text = getMessageText(message).trim()
    if (!text) continue
    requests.push(text)
    if (requests.length >= 8) {
      break
    }
  }

  return dedupeAndLimit(
    requests.map((request) => truncateText(request, 220)),
    4,
  )
}

function collectConstraints(messages: Message[]): string[] {
  const constraints: string[] = []
  const constraintRegex =
    /\b(must|should|need to|do not|don't|never|always|required|important|at all times)\b/i

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    if (isSummaryMessage(message)) continue

    const text = getMessageText(message).trim()
    if (!text) continue

    for (const line of text.split('\n')) {
      const normalized = normalizeLine(line)
      if (!normalized) continue
      if (!constraintRegex.test(normalized)) continue
      constraints.push(truncateText(normalized, 220))
      if (constraints.length >= 12) {
        break
      }
    }
  }

  return dedupeAndLimit(constraints, 6)
}

function collectOpenTodos(messages: Message[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }

    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName !== 'write_todos') {
        continue
      }

      const input = (part.input ?? {}) as TodoInput
      const todos = input.todos ?? []
      const openTodos = todos
        .filter((todo) => !todo.completed && typeof todo.task === 'string')
        .map((todo) => truncateText(todo.task as string, 180))

      if (openTodos.length > 0) {
        return dedupeAndLimit(openTodos, 6)
      }
    }
  }
  return []
}

function collectAssistantDecisions(messages: Message[]): string[] {
  const decisionLines: string[] = []
  const decisionRegex =
    /\b(i will|we will|we should|approach|plan|next step|decided)\b/i

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue

    const text = getMessageText(message).trim()
    if (!text) continue

    for (const line of text.split('\n')) {
      const normalized = normalizeLine(line)
      if (!normalized) continue
      if (!decisionRegex.test(normalized)) continue
      decisionLines.push(truncateText(normalized, 220))
      if (decisionLines.length >= 10) {
        break
      }
    }
  }

  return dedupeAndLimit(decisionLines, 4)
}

function collectPersistentMemory(
  persistedFrameText: string | undefined,
): string[] {
  if (!persistedFrameText?.trim()) {
    return []
  }

  const memoryLines: string[] = []
  let currentSection = ''

  for (const rawLine of persistedFrameText.split('\n')) {
    const line = normalizeLine(rawLine)
    if (!line) continue

    const sectionMatch = /^\[(.+)\]$/.exec(line)
    if (sectionMatch) {
      currentSection = (sectionMatch[1] ?? '').toUpperCase()
      continue
    }

    if (!line.startsWith('- ')) continue
    if (
      currentSection.includes('RETRIEVED FACTS') ||
      currentSection.includes('HIGH-IMPACT CONFLICTS') ||
      currentSection.includes('CONFLICT RESOLUTION LOG')
    ) {
      continue
    }

    memoryLines.push(truncateText(line.slice(2), 220))
  }

  return dedupeAndLimit(memoryLines, 8)
}

function buildMemoryFrameBody(params: {
  messages: Message[]
  prompt: string | undefined
  maxTokens: number
  persistedFrameText?: string
}): string {
  const { messages, prompt, maxTokens, persistedFrameText } = params

  const recentUserRequests = collectRecentUserRequests(messages, prompt)
  const constraints = collectConstraints(messages)
  const openTodos = collectOpenTodos(messages)
  const decisions = collectAssistantDecisions(messages)
  const persistedMemory = collectPersistentMemory(persistedFrameText)

  const lines = [
    '[RECENT USER REQUESTS]',
    ...(recentUserRequests.length > 0
      ? recentUserRequests.map((item) => `- ${item}`)
      : ['- (none)']),
    '',
    '[CONSTRAINTS TO RESPECT]',
    ...(constraints.length > 0
      ? constraints.map((item) => `- ${item}`)
      : ['- (none detected)']),
    '',
    '[LONG-RUN MEMORY]',
    ...(persistedMemory.length > 0
      ? persistedMemory.map((item) => `- ${item}`)
      : ['- (none)']),
    '',
    '[OPEN TASKS]',
    ...(openTodos.length > 0
      ? openTodos.map((item) => `- ${item}`)
      : ['- (none)']),
    '',
    '[WORKING DECISIONS]',
    ...(decisions.length > 0
      ? decisions.map((item) => `- ${item}`)
      : ['- (none)']),
  ]

  let body = lines.join('\n')
  const maxChars = Math.max(900, maxTokens * 3)
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars - 48)}\n...[memory frame truncated]...`
  }
  return body
}

function getSectionProfile(section: string): {
  confidence: number
  weight: number
  tag: string
} {
  const normalized = section.toUpperCase()
  if (normalized.includes('CONSTRAINT')) {
    return { confidence: 92, weight: 95, tag: 'constraint' }
  }
  if (normalized.includes('OPEN TASK')) {
    return { confidence: 85, weight: 88, tag: 'task' }
  }
  if (normalized.includes('DECISION')) {
    return { confidence: 80, weight: 82, tag: 'decision' }
  }
  if (normalized.includes('LONG-RUN')) {
    return { confidence: 88, weight: 90, tag: 'long_run' }
  }
  return { confidence: 74, weight: 72, tag: 'request' }
}

export function extractFactCandidatesFromFrameBody(
  frameBody: string,
  maxFacts: number = 24,
): MemoryFactCandidate[] {
  const candidates: MemoryFactCandidate[] = []
  const seen = new Set<string>()
  let currentSection = 'RECENT USER REQUESTS'

  for (const rawLine of frameBody.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const sectionMatch = /^\[(.+)\]$/.exec(line)
    if (sectionMatch) {
      currentSection = sectionMatch[1] ?? currentSection
      continue
    }

    if (!line.startsWith('- ')) continue

    const upperSection = currentSection.toUpperCase()
    if (
      upperSection.includes('RETRIEVED FACTS') ||
      upperSection.includes('HIGH-IMPACT CONFLICTS') ||
      upperSection.includes('CONFLICT RESOLUTION LOG')
    ) {
      continue
    }

    const content = line.slice(2).trim()
    if (!content) continue
    if (/^\((none|none detected)\)$/i.test(content)) continue

    const key = normalizeFactKey(content)
    if (!key) continue

    const dedupeKey = `${currentSection.toLowerCase()}::${key}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const profile = getSectionProfile(currentSection)
    candidates.push({
      key,
      content,
      confidence: profile.confidence,
      weight: profile.weight,
      tags: [profile.tag],
    })

    if (candidates.length >= maxFacts) {
      break
    }
  }

  return candidates
}

export function hydrateMemoryFrameForStep(params: {
  agentState: AgentState
  prompt: string | undefined
  maxTokens?: number
  persistedFrameText?: string
}): AgentState {
  const { agentState, prompt, maxTokens = 1500, persistedFrameText } = params

  const baseMemory = ensureMemoryState(agentState.memory)
  const historyWithoutFrame = agentState.messageHistory.filter(
    (message) => !isMemoryFrameMessage(message),
  )
  const body = buildMemoryFrameBody({
    messages: historyWithoutFrame,
    prompt,
    maxTokens,
    persistedFrameText:
      persistedFrameText ?? agentState.memory?.persistedFrameText,
  })
  const frameHash = hashString(body)
  const nextRevision =
    baseMemory.frameHash === frameHash
      ? baseMemory.revision
      : baseMemory.revision + 1

  const memoryFrame = `<memory_frame version="1" thread_id="${baseMemory.threadId}" revision="${nextRevision}">
${body}
</memory_frame>`

  const memoryMessage = userMessage({
    content: withSystemTags(memoryFrame),
    tags: [MEMORY_FRAME_TAG],
    keepDuringTruncation: true,
  })

  return {
    ...agentState,
    memory: {
      ...baseMemory,
      revision: nextRevision,
      frameHash,
      persistedFrameText: body,
      lastHydratedAt: Date.now(),
    },
    messageHistory: [...historyWithoutFrame, memoryMessage],
  }
}
