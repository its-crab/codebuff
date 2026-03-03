import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

import { postMemory } from '../_post'

import type { GetUserInfoFromApiKeyFn } from '@codebuff/common/types/contracts/database'
import type {
  Logger,
  LoggerWithContextFn,
} from '@codebuff/common/types/contracts/logger'

describe('/api/v1/memory POST endpoint', () => {
  const mockGetUserInfoFromApiKey: GetUserInfoFromApiKeyFn = async ({
    apiKey,
  }) => {
    if (apiKey !== 'valid-key') {
      return null
    }
    return {
      id: 'user-123',
      email: 'test@example.com',
      discord_id: 'disc-1',
    } as Awaited<ReturnType<GetUserInfoFromApiKeyFn>>
  }

  let mockLogger: Logger
  let mockLoggerWithContext: LoggerWithContextFn
  let mockDb: any

  beforeEach(() => {
    mockLogger = {
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
      debug: mock(() => {}),
    }
    mockLoggerWithContext = mock(() => mockLogger)

    const selectResponses: any[] = []
    const insertReturningResponses: any[] = []
    const updateReturningResponses: any[] = []

    const limit = mock(async () => selectResponses.shift() ?? [])
    const where = mock(() => ({
      limit,
      orderBy: mock(() => ({ limit })),
    }))

    mockDb = {
      __selectResponses: selectResponses,
      __insertReturningResponses: insertReturningResponses,
      __updateReturningResponses: updateReturningResponses,
      select: mock(() => ({
        from: mock(() => ({ where })),
      })),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(async () => insertReturningResponses.shift() ?? []),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(async () => updateReturningResponses.shift() ?? []),
          })),
        })),
      })),
    }
  })

  afterEach(() => {
    mock.restore()
  })

  test('returns 401 when authorization header is missing', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/memory', {
      method: 'POST',
      body: JSON.stringify({ action: 'HYDRATE', fingerprintId: 'fp-1' }),
    })

    const response = await postMemory({
      req,
      getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
      logger: mockLogger,
      loggerWithContext: mockLoggerWithContext,
      db: mockDb,
    })

    expect(response.status).toBe(401)
  })

  test('hydrates memory by creating a thread when none exists', async () => {
    mockDb.__selectResponses.push([], [])
    mockDb.__insertReturningResponses.push([
      {
        id: 'thread-1',
        user_id: 'user-123',
        fingerprint_id: 'fp-1',
        latest_revision: 0,
        frame_hash: null,
        frame_text: '',
        pinned_fact_ids: [],
        unresolved_conflict_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const req = new NextRequest('http://localhost:3000/api/v1/memory', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-key' },
      body: JSON.stringify({ action: 'HYDRATE', fingerprintId: 'fp-1' }),
    })

    const response = await postMemory({
      req,
      getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
      logger: mockLogger,
      loggerWithContext: mockLoggerWithContext,
      db: mockDb,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      threadId: 'thread-1',
      revision: 0,
      frameHash: null,
      frameText: '',
      pinnedFactIds: [],
      unresolvedConflictIds: [],
    })
  })

  test('upserts memory frame and returns canonical thread data', async () => {
    mockDb.__selectResponses.push([
      {
        id: 'thread-1',
        user_id: 'user-123',
        fingerprint_id: 'fp-1',
        latest_revision: 1,
        frame_hash: 'old',
        frame_text: 'old-frame',
        pinned_fact_ids: [],
        unresolved_conflict_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])
    mockDb.__updateReturningResponses.push([
      {
        id: 'thread-1',
        user_id: 'user-123',
        fingerprint_id: 'fp-1',
        latest_revision: 2,
        frame_hash: 'hash-2',
        frame_text: 'frame-2',
        pinned_fact_ids: ['fact-1'],
        unresolved_conflict_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const req = new NextRequest('http://localhost:3000/api/v1/memory', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-key' },
      body: JSON.stringify({
        action: 'UPSERT_FRAME',
        threadId: 'thread-1',
        fingerprintId: 'fp-1',
        revision: 2,
        frameHash: 'hash-2',
        frameText: 'frame-2',
        pinnedFactIds: ['fact-1'],
      }),
    })

    const response = await postMemory({
      req,
      getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
      logger: mockLogger,
      loggerWithContext: mockLoggerWithContext,
      db: mockDb,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      threadId: 'thread-1',
      revision: 2,
      frameHash: 'hash-2',
      frameText: 'frame-2',
      pinnedFactIds: ['fact-1'],
      unresolvedConflictIds: [],
    })
  })

  test('upserts facts and returns unresolved conflict list', async () => {
    mockDb.__selectResponses.push(
      [
        {
          id: 'thread-1',
          user_id: 'user-123',
          fingerprint_id: 'fp-1',
          latest_revision: 2,
          frame_hash: 'hash-2',
          frame_text: 'frame-2',
          pinned_fact_ids: [],
          unresolved_conflict_ids: [],
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      [],
    )
    mockDb.__insertReturningResponses.push([{ id: 'evt-1' }])

    const req = new NextRequest('http://localhost:3000/api/v1/memory', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-key' },
      body: JSON.stringify({
        action: 'UPSERT_FACTS',
        threadId: 'thread-1',
        fingerprintId: 'fp-1',
        facts: [],
      }),
    })

    const response = await postMemory({
      req,
      getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
      logger: mockLogger,
      loggerWithContext: mockLoggerWithContext,
      db: mockDb,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      threadId: 'thread-1',
      facts: [],
      unresolvedConflictIds: [],
      autoResolvedConflictIds: [],
      highImpactConflicts: [],
    })
  })

  test('auto-resolves low-confidence contradiction on fact upsert', async () => {
    const now = new Date()
    const firstFact = {
      id: 'fact-1',
      thread_id: 'thread-1',
      user_id: 'user-123',
      fact_key: 'api strategy',
      fact_hash: 'hash-1',
      content: 'Keep API v1 behavior',
      confidence: 30,
      weight: 55,
      tags: ['constraint'],
      source_event_id: 'evt-1',
      active: true,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    }
    const secondFact = {
      id: 'fact-2',
      thread_id: 'thread-1',
      user_id: 'user-123',
      fact_key: 'api strategy',
      fact_hash: 'hash-2',
      content: 'Migrate to API v2 behavior',
      confidence: 92,
      weight: 90,
      tags: ['decision'],
      source_event_id: 'evt-1',
      active: true,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    }

    mockDb.__selectResponses.push(
      [
        {
          id: 'thread-1',
          user_id: 'user-123',
          fingerprint_id: 'fp-1',
          latest_revision: 2,
          frame_hash: 'hash-2',
          frame_text: 'frame-2',
          pinned_fact_ids: [],
          unresolved_conflict_ids: [],
          created_at: now,
          updated_at: now,
        },
      ],
      [],
      [firstFact],
      [],
      [secondFact, firstFact],
      [],
    )
    mockDb.__insertReturningResponses.push(
      [{ id: 'evt-1' }],
      [firstFact],
      [secondFact],
      [{ id: 'conflict-1' }],
    )

    const req = new NextRequest('http://localhost:3000/api/v1/memory', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-key' },
      body: JSON.stringify({
        action: 'UPSERT_FACTS',
        threadId: 'thread-1',
        fingerprintId: 'fp-1',
        facts: [
          {
            key: 'api strategy',
            content: firstFact.content,
            confidence: firstFact.confidence,
            weight: firstFact.weight,
            tags: firstFact.tags,
          },
          {
            key: 'api strategy',
            content: secondFact.content,
            confidence: secondFact.confidence,
            weight: secondFact.weight,
            tags: secondFact.tags,
          },
        ],
      }),
    })

    const response = await postMemory({
      req,
      getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
      logger: mockLogger,
      loggerWithContext: mockLoggerWithContext,
      db: mockDb,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.threadId).toBe('thread-1')
    expect(body.facts).toHaveLength(2)
    expect(body.unresolvedConflictIds).toEqual([])
    expect(body.autoResolvedConflictIds).toEqual(['conflict-1'])
    expect(body.highImpactConflicts).toEqual([])
  })

  test('keeps unresolved high-impact contradictions visible on upsert', async () => {
    const now = new Date()
    const firstFact = {
      id: 'fact-1',
      thread_id: 'thread-1',
      user_id: 'user-123',
      fact_key: 'api compatibility',
      fact_hash: 'hash-1',
      content: 'Do not break API compatibility',
      confidence: 94,
      weight: 95,
      tags: ['constraint'],
      source_event_id: 'evt-1',
      active: true,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    }
    const secondFact = {
      id: 'fact-2',
      thread_id: 'thread-1',
      user_id: 'user-123',
      fact_key: 'api compatibility',
      fact_hash: 'hash-2',
      content: 'Break API compatibility for speed',
      confidence: 93,
      weight: 92,
      tags: ['decision'],
      source_event_id: 'evt-1',
      active: true,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    }

    mockDb.__selectResponses.push(
      [
        {
          id: 'thread-1',
          user_id: 'user-123',
          fingerprint_id: 'fp-1',
          latest_revision: 2,
          frame_hash: 'hash-2',
          frame_text: 'frame-2',
          pinned_fact_ids: [],
          unresolved_conflict_ids: [],
          created_at: now,
          updated_at: now,
        },
      ],
      [],
      [firstFact],
      [],
      [secondFact, firstFact],
      [
        {
          id: 'conflict-1',
          thread_id: 'thread-1',
          user_id: 'user-123',
          left_fact_id: 'fact-1',
          right_fact_id: 'fact-2',
          status: 'unresolved',
          reason: 'facts_with_same_key_disagree',
          created_at: now,
          resolved_at: null,
        },
      ],
      [firstFact, secondFact],
    )
    mockDb.__insertReturningResponses.push(
      [{ id: 'evt-1' }],
      [firstFact],
      [secondFact],
      [{ id: 'conflict-1' }],
    )

    const req = new NextRequest('http://localhost:3000/api/v1/memory', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-key' },
      body: JSON.stringify({
        action: 'UPSERT_FACTS',
        threadId: 'thread-1',
        fingerprintId: 'fp-1',
        facts: [
          {
            key: 'api compatibility',
            content: firstFact.content,
            confidence: firstFact.confidence,
            weight: firstFact.weight,
            tags: firstFact.tags,
          },
          {
            key: 'api compatibility',
            content: secondFact.content,
            confidence: secondFact.confidence,
            weight: secondFact.weight,
            tags: secondFact.tags,
          },
        ],
      }),
    })

    const response = await postMemory({
      req,
      getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
      logger: mockLogger,
      loggerWithContext: mockLoggerWithContext,
      db: mockDb,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.threadId).toBe('thread-1')
    expect(body.unresolvedConflictIds).toEqual(['conflict-1'])
    expect(body.autoResolvedConflictIds).toEqual([])
    expect(body.highImpactConflicts).toHaveLength(1)
    expect(body.highImpactConflicts[0].id).toBe('conflict-1')
  })

  test('queries facts and returns ranked results envelope', async () => {
    mockDb.__selectResponses.push(
      [
        {
          id: 'thread-1',
          user_id: 'user-123',
          fingerprint_id: 'fp-1',
          latest_revision: 2,
          frame_hash: 'hash-2',
          frame_text: 'frame-2',
          pinned_fact_ids: [],
          unresolved_conflict_ids: ['conflict-1'],
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      [
        {
          id: 'fact-1',
          thread_id: 'thread-1',
          user_id: 'user-123',
          fact_key: 'api compatibility',
          fact_hash: 'h1',
          content: 'Do not break API compatibility',
          confidence: 92,
          weight: 95,
          tags: ['constraint'],
          source_event_id: null,
          active: true,
          last_seen_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      [
        {
          id: 'conflict-1',
          thread_id: 'thread-1',
          user_id: 'user-123',
          left_fact_id: 'fact-1',
          right_fact_id: 'fact-2',
          status: 'unresolved',
          reason: 'facts_with_same_key_disagree',
          created_at: new Date(),
          resolved_at: null,
        },
      ],
      [
        {
          id: 'fact-1',
          thread_id: 'thread-1',
          user_id: 'user-123',
          fact_key: 'api compatibility',
          fact_hash: 'h1',
          content: 'Do not break API compatibility',
          confidence: 92,
          weight: 95,
          tags: ['constraint'],
          source_event_id: null,
          active: true,
          last_seen_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'fact-2',
          thread_id: 'thread-1',
          user_id: 'user-123',
          fact_key: 'api compatibility',
          fact_hash: 'h2',
          content: 'Break API compatibility when needed',
          confidence: 90,
          weight: 90,
          tags: ['decision'],
          source_event_id: null,
          active: true,
          last_seen_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    )
    mockDb.__insertReturningResponses.push([{ id: 'evt-2' }])

    const req = new NextRequest('http://localhost:3000/api/v1/memory', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-key' },
      body: JSON.stringify({
        action: 'QUERY_FACTS',
        threadId: 'thread-1',
        fingerprintId: 'fp-1',
        query: 'compatibility',
      }),
    })

    const response = await postMemory({
      req,
      getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
      logger: mockLogger,
      loggerWithContext: mockLoggerWithContext,
      db: mockDb,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.threadId).toBe('thread-1')
    expect(body.unresolvedConflictIds).toEqual(['conflict-1'])
    expect(body.facts).toHaveLength(1)
    expect(body.facts[0].content).toContain('API compatibility')
    expect(body.highImpactConflicts).toHaveLength(1)
  })
})
