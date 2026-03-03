import * as schema from '@codebuff/internal/db/schema'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import type { GetUserInfoFromApiKeyFn } from '@codebuff/common/types/contracts/database'
import type {
  Logger,
  LoggerWithContextFn,
} from '@codebuff/common/types/contracts/logger'
import type { CodebuffPgDatabase } from '@codebuff/internal/db/types'
import type { NextRequest } from 'next/server'

import { extractApiKeyFromHeader } from '@/util/auth'

const hydrateMemorySchema = z.object({
  action: z.literal('HYDRATE'),
  threadId: z.string().optional(),
  fingerprintId: z.string().min(1).max(255),
})

const upsertMemoryFrameSchema = z.object({
  action: z.literal('UPSERT_FRAME'),
  threadId: z.string().optional(),
  fingerprintId: z.string().min(1).max(255),
  revision: z.number().int().nonnegative(),
  frameHash: z.string().min(1),
  frameText: z.string().max(60_000),
  pinnedFactIds: z.array(z.string()).optional(),
  unresolvedConflictIds: z.array(z.string()).optional(),
})

const upsertMemoryFactsSchema = z.object({
  action: z.literal('UPSERT_FACTS'),
  threadId: z.string().optional(),
  fingerprintId: z.string().min(1).max(255),
  facts: z
    .array(
      z.object({
        key: z.string().optional(),
        content: z.string().min(1).max(2_000),
        confidence: z.number().int().min(0).max(100).optional(),
        weight: z.number().int().min(0).max(100).optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .max(100),
})

const queryMemoryFactsSchema = z.object({
  action: z.literal('QUERY_FACTS'),
  threadId: z.string().optional(),
  fingerprintId: z.string().min(1).max(255),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

const memoryRequestSchema = z.discriminatedUnion('action', [
  hydrateMemorySchema,
  upsertMemoryFrameSchema,
  upsertMemoryFactsSchema,
  queryMemoryFactsSchema,
])

type MemoryThreadRow = typeof schema.memoryThread.$inferSelect
type MemoryFactRow = typeof schema.memoryFact.$inferSelect
type MemoryConflictRow = typeof schema.memoryConflict.$inferSelect

type UpsertFactInput = z.infer<typeof upsertMemoryFactsSchema>['facts'][number]

type MemoryConflictInsight = {
  id: string
  key: string
  leftContent: string
  rightContent: string
  leftConfidence: number
  rightConfidence: number
  leftWeight: number
  rightWeight: number
  importance: number
}

const LOW_CONFIDENCE_CUTOFF = 45
const AUTO_RESOLVE_STRENGTH_GAP = 22
const HIGH_IMPACT_IMPORTANCE = 110

function clamp0to100(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback
  }
  return Math.max(0, Math.min(100, value))
}

function normalizeFactKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

function normalizeFactText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000)
}

function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function tokenizeQuery(query: string | undefined): string[] {
  if (!query?.trim()) {
    return []
  }
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3)

  return Array.from(new Set(words)).slice(0, 20)
}

function getFactStrength(fact: Pick<MemoryFactRow, 'confidence' | 'weight'>): number {
  return fact.confidence * 0.65 + fact.weight * 0.35
}

function getConflictImportance(left: MemoryFactRow, right: MemoryFactRow): number {
  const leftStrength = getFactStrength(left)
  const rightStrength = getFactStrength(right)
  return Math.max(leftStrength, rightStrength) + Math.min(leftStrength, rightStrength) * 0.45
}

function shouldAutoResolveConflict(params: {
  left: MemoryFactRow
  right: MemoryFactRow
}): { shouldResolve: boolean; weakerFactId: string } {
  const { left, right } = params
  const leftStrength = getFactStrength(left)
  const rightStrength = getFactStrength(right)
  const weaker = leftStrength <= rightStrength ? left : right
  const stronger = leftStrength <= rightStrength ? right : left
  const strengthGap = Math.abs(leftStrength - rightStrength)

  const shouldResolve =
    weaker.confidence <= LOW_CONFIDENCE_CUTOFF &&
    stronger.confidence >= weaker.confidence &&
    strengthGap >= AUTO_RESOLVE_STRENGTH_GAP

  return { shouldResolve, weakerFactId: weaker.id }
}

function toMemoryFrameResponse(row: MemoryThreadRow) {
  return {
    threadId: row.id,
    revision: row.latest_revision,
    frameHash: row.frame_hash,
    frameText: row.frame_text,
    pinnedFactIds: row.pinned_fact_ids ?? [],
    unresolvedConflictIds: row.unresolved_conflict_ids ?? [],
  }
}

function toMemoryFactResponse(row: MemoryFactRow) {
  return {
    id: row.id,
    key: row.fact_key,
    content: row.content,
    confidence: row.confidence,
    weight: row.weight,
    tags: row.tags ?? [],
    updatedAt: row.updated_at.toISOString(),
  }
}

function toMemoryConflictResponse(params: {
  row: MemoryConflictRow
  left: MemoryFactRow
  right: MemoryFactRow
}): MemoryConflictInsight {
  const { row, left, right } = params
  return {
    id: row.id,
    key: left.fact_key,
    leftContent: left.content,
    rightContent: right.content,
    leftConfidence: left.confidence,
    rightConfidence: right.confidence,
    leftWeight: left.weight,
    rightWeight: right.weight,
    importance: getConflictImportance(left, right),
  }
}

async function findOrCreateThread(params: {
  db: CodebuffPgDatabase
  userId: string
  threadId?: string
  fingerprintId: string
}): Promise<{ row: MemoryThreadRow; created: boolean } | null> {
  const { db, userId, threadId, fingerprintId } = params

  if (threadId) {
    const existing = await db
      .select()
      .from(schema.memoryThread)
      .where(eq(schema.memoryThread.id, threadId))
      .limit(1)

    if (existing[0] && existing[0].user_id !== userId) {
      return null
    }

    if (existing[0]) {
      return { row: existing[0], created: false }
    }

    const created = await db
      .insert(schema.memoryThread)
      .values({
        id: threadId,
        user_id: userId,
        fingerprint_id: fingerprintId,
      })
      .returning()

    if (created[0]) {
      return { row: created[0], created: true }
    }
  }

  const latestForFingerprint = await db
    .select()
    .from(schema.memoryThread)
    .where(
      and(
        eq(schema.memoryThread.user_id, userId),
        eq(schema.memoryThread.fingerprint_id, fingerprintId),
      ),
    )
    .orderBy(desc(schema.memoryThread.updated_at))
    .limit(1)

  if (latestForFingerprint[0]) {
    return { row: latestForFingerprint[0], created: false }
  }

  const created = await db
    .insert(schema.memoryThread)
    .values({
      user_id: userId,
      fingerprint_id: fingerprintId,
    })
    .returning()

  if (!created[0]) {
    return null
  }

  return { row: created[0], created: true }
}

async function appendMemoryEvent(params: {
  db: CodebuffPgDatabase
  userId: string
  threadId: string
  eventType: 'hydrate' | 'upsert_frame' | 'upsert_facts' | 'query_facts'
  payload: Record<string, unknown>
  logger: Logger
}): Promise<string | null> {
  const { db, userId, threadId, eventType, payload, logger } = params

  try {
    const inserted = await db
      .insert(schema.memoryEvent)
      .values({
        user_id: userId,
        thread_id: threadId,
        event_type: eventType,
        payload,
      })
      .returning({ id: schema.memoryEvent.id })

    return inserted[0]?.id ?? null
  } catch (error) {
    logger.warn(
      { error, userId, threadId, eventType },
      'Failed to append memory event',
    )
    return null
  }
}

async function upsertFact(params: {
  db: CodebuffPgDatabase
  userId: string
  threadId: string
  sourceEventId: string | null
  fact: UpsertFactInput
}): Promise<{ row: MemoryFactRow; autoResolvedConflictIds: string[] } | null> {
  const { db, userId, threadId, sourceEventId, fact } = params

  const content = normalizeFactText(fact.content)
  if (!content) {
    return null
  }

  const factKey = normalizeFactKey(fact.key ?? content)
  if (!factKey) {
    return null
  }

  const factHash = hashString(`${factKey}::${content}`)

  const existingByHash = await db
    .select()
    .from(schema.memoryFact)
    .where(
      and(
        eq(schema.memoryFact.thread_id, threadId),
        eq(schema.memoryFact.fact_hash, factHash),
      ),
    )
    .limit(1)

  let row: MemoryFactRow

  if (existingByHash[0]) {
    const existing = existingByHash[0]
    const updatedRows = await db
      .update(schema.memoryFact)
      .set({
        confidence: clamp0to100(fact.confidence, existing.confidence),
        weight: clamp0to100(fact.weight, existing.weight),
        tags: fact.tags ?? existing.tags,
        source_event_id: sourceEventId ?? existing.source_event_id,
        active: true,
        last_seen_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(schema.memoryFact.id, existing.id))
      .returning()

    if (!updatedRows[0]) {
      return null
    }

    row = updatedRows[0]
  } else {
    const inserted = await db
      .insert(schema.memoryFact)
      .values({
        thread_id: threadId,
        user_id: userId,
        fact_key: factKey,
        fact_hash: factHash,
        content,
        confidence: clamp0to100(fact.confidence, 72),
        weight: clamp0to100(fact.weight, 70),
        tags: fact.tags ?? [],
        source_event_id: sourceEventId,
        active: true,
      })
      .returning()

    if (!inserted[0]) {
      return null
    }

    row = inserted[0]
  }

  const peers = await db
    .select()
    .from(schema.memoryFact)
    .where(
      and(
        eq(schema.memoryFact.thread_id, threadId),
        eq(schema.memoryFact.fact_key, factKey),
        eq(schema.memoryFact.active, true),
      ),
    )
    .orderBy(desc(schema.memoryFact.updated_at))
    .limit(8)

  const autoResolvedConflictIds: string[] = []

  for (const peer of peers) {
    if (peer.id === row.id) continue
    if (normalizeFactText(peer.content) === normalizeFactText(row.content)) continue

    const [leftFactId, rightFactId] = [peer.id, row.id].sort()
    let conflictId: string | null = null

    try {
      const insertedConflict = await db
        .insert(schema.memoryConflict)
        .values({
          thread_id: threadId,
          user_id: userId,
          left_fact_id: leftFactId,
          right_fact_id: rightFactId,
          status: 'unresolved',
          reason: 'facts_with_same_key_disagree',
        })
        .returning({ id: schema.memoryConflict.id })

      conflictId = insertedConflict[0]?.id ?? null
    } catch {
      const existingConflict = await db
        .select({
          id: schema.memoryConflict.id,
          status: schema.memoryConflict.status,
        })
        .from(schema.memoryConflict)
        .where(
          and(
            eq(schema.memoryConflict.thread_id, threadId),
            eq(schema.memoryConflict.left_fact_id, leftFactId),
            eq(schema.memoryConflict.right_fact_id, rightFactId),
          ),
        )
        .limit(1)

      if (existingConflict[0]?.id) {
        conflictId = existingConflict[0].id
        if (existingConflict[0].status === 'resolved') {
          await db
            .update(schema.memoryConflict)
            .set({
              status: 'unresolved',
              resolved_at: null,
              reason: 'facts_with_same_key_disagree',
            })
            .where(eq(schema.memoryConflict.id, existingConflict[0].id))
        }
      }
    }

    if (!conflictId) {
      continue
    }

    const { shouldResolve, weakerFactId } = shouldAutoResolveConflict({
      left: peer,
      right: row,
    })
    if (shouldResolve) {
      await db
        .update(schema.memoryFact)
        .set({
          active: false,
          updated_at: new Date(),
        })
        .where(eq(schema.memoryFact.id, weakerFactId))

      await db
        .update(schema.memoryConflict)
        .set({
          status: 'resolved',
          resolved_at: new Date(),
          reason: 'auto_resolved_low_confidence',
        })
        .where(eq(schema.memoryConflict.id, conflictId))

      autoResolvedConflictIds.push(conflictId)

      try {
        const strongerFactId = weakerFactId === row.id ? peer.id : row.id
        await db.insert(schema.memoryFactEdge).values({
          thread_id: threadId,
          user_id: userId,
          from_fact_id: strongerFactId,
          to_fact_id: weakerFactId,
          relation: 'supersedes',
          weight: 90,
        })
      } catch {
        // Relation can already exist; ignore duplicate insert errors.
      }
    }

    try {
      await db.insert(schema.memoryFactEdge).values({
        thread_id: threadId,
        user_id: userId,
        from_fact_id: leftFactId,
        to_fact_id: rightFactId,
        relation: 'contradicts',
        weight: 85,
      })
    } catch {
      // Edge may already exist; ignore duplicate inserts.
    }
  }

  return { row, autoResolvedConflictIds }
}

async function collectConflictState(params: {
  db: CodebuffPgDatabase
  threadId: string
}): Promise<{
  unresolvedConflictIds: string[]
  highImpactConflicts: MemoryConflictInsight[]
}> {
  const { db, threadId } = params

  const conflicts = await db
    .select()
    .from(schema.memoryConflict)
    .where(
      and(
        eq(schema.memoryConflict.thread_id, threadId),
        eq(schema.memoryConflict.status, 'unresolved'),
      ),
    )
    .orderBy(desc(schema.memoryConflict.created_at))
    .limit(200)

  const unresolvedConflictIds = conflicts.map((conflict) => conflict.id)
  if (conflicts.length === 0) {
    return {
      unresolvedConflictIds,
      highImpactConflicts: [],
    }
  }

  const factIds = Array.from(
    new Set(
      conflicts.flatMap((conflict) => [conflict.left_fact_id, conflict.right_fact_id]),
    ),
  )
  const facts = await db
    .select()
    .from(schema.memoryFact)
    .where(inArray(schema.memoryFact.id, factIds))
    .limit(500)

  const factById = new Map(facts.map((fact) => [fact.id, fact]))
  const highImpactConflicts = conflicts
    .map((conflict) => {
      const left = factById.get(conflict.left_fact_id)
      const right = factById.get(conflict.right_fact_id)
      if (!left || !right) return null

      const insight = toMemoryConflictResponse({
        row: conflict,
        left,
        right,
      })

      if (insight.importance < HIGH_IMPACT_IMPORTANCE) {
        return null
      }

      return insight
    })
    .filter((insight): insight is MemoryConflictInsight => !!insight)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8)

  return {
    unresolvedConflictIds,
    highImpactConflicts,
  }
}

async function handleHydrate(params: {
  db: CodebuffPgDatabase
  userId: string
  data: z.infer<typeof hydrateMemorySchema>
  logger: Logger
}) {
  const { db, userId, data, logger } = params

  const thread = await findOrCreateThread({
    db,
    userId,
    threadId: data.threadId,
    fingerprintId: data.fingerprintId,
  })

  if (!thread) {
    return NextResponse.json(
      { error: 'Memory thread does not belong to user' },
      { status: 403 },
    )
  }

  await appendMemoryEvent({
    db,
    userId,
    threadId: thread.row.id,
    eventType: 'hydrate',
    payload: {
      requestedThreadId: data.threadId ?? null,
      fingerprintId: data.fingerprintId,
      created: thread.created,
    },
    logger,
  })

  return NextResponse.json(toMemoryFrameResponse(thread.row))
}

async function handleUpsertFrame(params: {
  db: CodebuffPgDatabase
  userId: string
  data: z.infer<typeof upsertMemoryFrameSchema>
  logger: Logger
}) {
  const { db, userId, data, logger } = params

  const thread = await findOrCreateThread({
    db,
    userId,
    threadId: data.threadId,
    fingerprintId: data.fingerprintId,
  })

  if (!thread) {
    return NextResponse.json(
      { error: 'Memory thread does not belong to user' },
      { status: 403 },
    )
  }

  let canonicalRow = thread.row
  const shouldApply = data.revision >= thread.row.latest_revision

  if (shouldApply) {
    const updatedRows = await db
      .update(schema.memoryThread)
      .set({
        fingerprint_id: data.fingerprintId,
        latest_revision: data.revision,
        frame_hash: data.frameHash,
        frame_text: data.frameText,
        pinned_fact_ids: data.pinnedFactIds ?? thread.row.pinned_fact_ids,
        unresolved_conflict_ids:
          data.unresolvedConflictIds ?? thread.row.unresolved_conflict_ids,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(schema.memoryThread.id, thread.row.id),
          eq(schema.memoryThread.user_id, userId),
        ),
      )
      .returning()

    if (updatedRows[0]) {
      canonicalRow = updatedRows[0]
    }
  }

  await appendMemoryEvent({
    db,
    userId,
    threadId: canonicalRow.id,
    eventType: 'upsert_frame',
    payload: {
      requestedThreadId: data.threadId ?? null,
      fingerprintId: data.fingerprintId,
      requestedRevision: data.revision,
      applied: shouldApply,
      canonicalRevision: canonicalRow.latest_revision,
    },
    logger,
  })

  return NextResponse.json(toMemoryFrameResponse(canonicalRow))
}

async function handleUpsertFacts(params: {
  db: CodebuffPgDatabase
  userId: string
  data: z.infer<typeof upsertMemoryFactsSchema>
  logger: Logger
}) {
  const { db, userId, data, logger } = params

  const thread = await findOrCreateThread({
    db,
    userId,
    threadId: data.threadId,
    fingerprintId: data.fingerprintId,
  })

  if (!thread) {
    return NextResponse.json(
      { error: 'Memory thread does not belong to user' },
      { status: 403 },
    )
  }

  const sourceEventId = await appendMemoryEvent({
    db,
    userId,
    threadId: thread.row.id,
    eventType: 'upsert_facts',
    payload: {
      requestedThreadId: data.threadId ?? null,
      fingerprintId: data.fingerprintId,
      factCount: data.facts.length,
    },
    logger,
  })

  const upsertedRows: MemoryFactRow[] = []
  const autoResolvedConflictIds = new Set<string>()
  for (const fact of data.facts) {
    const result = await upsertFact({
      db,
      userId,
      threadId: thread.row.id,
      sourceEventId,
      fact,
    })

    if (result?.row) {
      upsertedRows.push(result.row)
      for (const conflictId of result.autoResolvedConflictIds) {
        autoResolvedConflictIds.add(conflictId)
      }
    }
  }

  const { unresolvedConflictIds, highImpactConflicts } = await collectConflictState({
    db,
    threadId: thread.row.id,
  })

  await db
    .update(schema.memoryThread)
    .set({
      unresolved_conflict_ids: unresolvedConflictIds,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(schema.memoryThread.id, thread.row.id),
        eq(schema.memoryThread.user_id, userId),
      ),
    )

  return NextResponse.json({
    threadId: thread.row.id,
    facts: upsertedRows.map(toMemoryFactResponse),
    unresolvedConflictIds,
    autoResolvedConflictIds: Array.from(autoResolvedConflictIds),
    highImpactConflicts,
  })
}

async function handleQueryFacts(params: {
  db: CodebuffPgDatabase
  userId: string
  data: z.infer<typeof queryMemoryFactsSchema>
  logger: Logger
}) {
  const { db, userId, data, logger } = params

  const thread = await findOrCreateThread({
    db,
    userId,
    threadId: data.threadId,
    fingerprintId: data.fingerprintId,
  })

  if (!thread) {
    return NextResponse.json(
      { error: 'Memory thread does not belong to user' },
      { status: 403 },
    )
  }

  const limit = data.limit ?? 10
  const queryTokens = tokenizeQuery(data.query)

  const facts = await db
    .select()
    .from(schema.memoryFact)
    .where(
      and(
        eq(schema.memoryFact.thread_id, thread.row.id),
        eq(schema.memoryFact.active, true),
      ),
    )
    .orderBy(desc(schema.memoryFact.updated_at))
    .limit(300)

  const now = Date.now()
  const rankedFacts = facts
    .map((fact) => {
      const haystack = `${fact.fact_key} ${fact.content}`.toLowerCase()
      const overlapCount = queryTokens.filter((token) => haystack.includes(token)).length
      const daysSinceUpdate =
        (now - fact.updated_at.getTime()) / (1000 * 60 * 60 * 24)
      const recencyBonus = Math.max(0, 20 - daysSinceUpdate)
      const score = fact.weight + fact.confidence + overlapCount * 25 + recencyBonus

      return { fact, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.fact)

  await appendMemoryEvent({
    db,
    userId,
    threadId: thread.row.id,
    eventType: 'query_facts',
    payload: {
      query: data.query ?? '',
      tokenCount: queryTokens.length,
      requestedLimit: limit,
      resultCount: rankedFacts.length,
    },
    logger,
  })

  const { unresolvedConflictIds, highImpactConflicts } = await collectConflictState({
    db,
    threadId: thread.row.id,
  })

  return NextResponse.json({
    threadId: thread.row.id,
    facts: rankedFacts.map(toMemoryFactResponse),
    unresolvedConflictIds,
    highImpactConflicts,
  })
}

export async function postMemory(params: {
  req: NextRequest
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  logger: Logger
  loggerWithContext: LoggerWithContextFn
  db: CodebuffPgDatabase
}) {
  const { req, getUserInfoFromApiKey, loggerWithContext, db } = params
  let { logger } = params

  const apiKey = extractApiKeyFromHeader(req)

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Missing or invalid Authorization header' },
      { status: 401 },
    )
  }

  const userInfo = await getUserInfoFromApiKey({
    apiKey,
    fields: ['id', 'email', 'discord_id'],
    logger,
  })

  if (!userInfo) {
    return NextResponse.json(
      { error: 'Invalid API key or user not found' },
      { status: 404 },
    )
  }

  logger = loggerWithContext({ userInfo })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 },
    )
  }

  const parseResult = memoryRequestSchema.safeParse(body)
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parseResult.error.format() },
      { status: 400 },
    )
  }

  const data = parseResult.data
  if (data.action === 'HYDRATE') {
    return handleHydrate({ db, userId: userInfo.id, data, logger })
  }
  if (data.action === 'UPSERT_FRAME') {
    return handleUpsertFrame({ db, userId: userInfo.id, data, logger })
  }
  if (data.action === 'UPSERT_FACTS') {
    return handleUpsertFacts({ db, userId: userInfo.id, data, logger })
  }

  return handleQueryFacts({ db, userId: userInfo.id, data, logger })
}
