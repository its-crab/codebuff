import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getErrorObject } from '@codebuff/common/util/error'

import { getConfigDir } from '../credentials'

import type {
  FetchMemoryFrameFn,
  MemoryConflictRecord,
  MemoryFactRecord,
  MemoryFrameRecord,
  QueryMemoryFactsFn,
  SaveMemoryFrameFn,
  UpsertMemoryFactsFn,
} from '@codebuff/common/types/contracts/database'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const MEMORY_STORE_FILE = 'memory-store.json'
const MEMORY_STORE_VERSION = 1

const LOW_CONFIDENCE_CUTOFF = 45
const AUTO_RESOLVE_STRENGTH_GAP = 22
const HIGH_IMPACT_IMPORTANCE = 110

type LocalMemoryStore = {
  version: number
  users: Record<string, LocalMemoryUserBucket>
}

type LocalMemoryUserBucket = {
  latestThreadByFingerprint: Record<string, string>
  threads: Record<string, LocalMemoryThread>
}

type LocalMemoryThread = {
  id: string
  fingerprintId: string
  latestRevision: number
  frameHash: string | null
  frameText: string
  pinnedFactIds: string[]
  unresolvedConflictIds: string[]
  updatedAt: number
  facts: LocalMemoryFact[]
  conflicts: LocalMemoryConflict[]
}

type LocalMemoryFact = {
  id: string
  factKey: string
  factHash: string
  content: string
  confidence: number
  weight: number
  tags: string[]
  active: boolean
  createdAt: number
  updatedAt: number
  lastSeenAt: number
}

type LocalMemoryConflict = {
  id: string
  leftFactId: string
  rightFactId: string
  status: 'unresolved' | 'resolved'
  reason: string
  createdAt: number
  updatedAt: number
  resolvedAt?: number
}

function getMemoryStorePath(): string {
  return path.join(getConfigDir(), MEMORY_STORE_FILE)
}

function createDefaultStore(): LocalMemoryStore {
  return {
    version: MEMORY_STORE_VERSION,
    users: {},
  }
}

function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 32)
}

function ensureParentDirectory(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function readStore(logger: Logger): LocalMemoryStore {
  const storePath = getMemoryStorePath()
  if (!fs.existsSync(storePath)) {
    return createDefaultStore()
  }

  try {
    const raw = fs.readFileSync(storePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<LocalMemoryStore>
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.version !== 'number' ||
      typeof parsed.users !== 'object' ||
      parsed.users === null
    ) {
      throw new Error('Invalid local memory store shape')
    }

    return {
      version: parsed.version,
      users: parsed.users as Record<string, LocalMemoryUserBucket>,
    }
  } catch (error) {
    logger.warn(
      { error: getErrorObject(error), storePath },
      'Failed to parse local memory store; resetting to empty store',
    )
    return createDefaultStore()
  }
}

function writeStore(store: LocalMemoryStore, logger: Logger): void {
  const storePath = getMemoryStorePath()
  ensureParentDirectory(storePath)
  const tempPath = `${storePath}.tmp.${process.pid}.${Date.now()}`

  try {
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8')
    fs.renameSync(tempPath, storePath)
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
      }
    } catch {
      // Best-effort temp cleanup.
    }
    logger.warn(
      { error: getErrorObject(error), storePath },
      'Failed to persist local memory store',
    )
  }
}

function ensureUserBucket(
  store: LocalMemoryStore,
  apiKey: string,
): LocalMemoryUserBucket {
  const userKey = hashApiKey(apiKey)
  if (!store.users[userKey]) {
    store.users[userKey] = {
      latestThreadByFingerprint: {},
      threads: {},
    }
  }
  return store.users[userKey]!
}

function createThread(params: {
  threadId: string
  fingerprintId: string
}): LocalMemoryThread {
  const { threadId, fingerprintId } = params
  return {
    id: threadId,
    fingerprintId,
    latestRevision: 0,
    frameHash: null,
    frameText: '',
    pinnedFactIds: [],
    unresolvedConflictIds: [],
    updatedAt: Date.now(),
    facts: [],
    conflicts: [],
  }
}

function findOrCreateThread(params: {
  bucket: LocalMemoryUserBucket
  fingerprintId: string
  threadId?: string
}): { thread: LocalMemoryThread; created: boolean } {
  const { bucket, fingerprintId, threadId } = params

  if (threadId && bucket.threads[threadId]) {
    return { thread: bucket.threads[threadId]!, created: false }
  }

  const existingThreadId = bucket.latestThreadByFingerprint[fingerprintId]
  if (!threadId && existingThreadId && bucket.threads[existingThreadId]) {
    return { thread: bucket.threads[existingThreadId]!, created: false }
  }

  const id = threadId ?? crypto.randomUUID()
  const createdThread = createThread({ threadId: id, fingerprintId })
  bucket.threads[id] = createdThread
  bucket.latestThreadByFingerprint[fingerprintId] = id
  return { thread: createdThread, created: true }
}

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

function getFactStrength(fact: Pick<LocalMemoryFact, 'confidence' | 'weight'>): number {
  return fact.confidence * 0.65 + fact.weight * 0.35
}

function getConflictImportance(left: LocalMemoryFact, right: LocalMemoryFact): number {
  const leftStrength = getFactStrength(left)
  const rightStrength = getFactStrength(right)
  return Math.max(leftStrength, rightStrength) + Math.min(leftStrength, rightStrength) * 0.45
}

function shouldAutoResolveConflict(params: {
  left: LocalMemoryFact
  right: LocalMemoryFact
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

function toMemoryFrameResponse(thread: LocalMemoryThread): MemoryFrameRecord {
  return {
    threadId: thread.id,
    revision: thread.latestRevision,
    frameHash: thread.frameHash,
    frameText: thread.frameText,
    pinnedFactIds: [...thread.pinnedFactIds],
    unresolvedConflictIds: [...thread.unresolvedConflictIds],
  }
}

function toMemoryFactResponse(fact: LocalMemoryFact): MemoryFactRecord {
  return {
    id: fact.id,
    key: fact.factKey,
    content: fact.content,
    confidence: fact.confidence,
    weight: fact.weight,
    tags: [...fact.tags],
    updatedAt: new Date(fact.updatedAt).toISOString(),
  }
}

function toMemoryConflictResponse(params: {
  conflict: LocalMemoryConflict
  left: LocalMemoryFact
  right: LocalMemoryFact
}): MemoryConflictRecord {
  const { conflict, left, right } = params
  return {
    id: conflict.id,
    key: left.factKey,
    leftContent: left.content,
    rightContent: right.content,
    leftConfidence: left.confidence,
    rightConfidence: right.confidence,
    leftWeight: left.weight,
    rightWeight: right.weight,
    importance: getConflictImportance(left, right),
  }
}

function collectConflictState(thread: LocalMemoryThread): {
  unresolvedConflictIds: string[]
  highImpactConflicts: MemoryConflictRecord[]
} {
  const unresolved = thread.conflicts
    .filter((conflict) => conflict.status === 'unresolved')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200)

  const unresolvedConflictIds = unresolved.map((conflict) => conflict.id)
  if (unresolved.length === 0) {
    return {
      unresolvedConflictIds,
      highImpactConflicts: [],
    }
  }

  const factById = new Map(thread.facts.map((fact) => [fact.id, fact]))
  const highImpactConflicts = unresolved
    .map((conflict) => {
      const left = factById.get(conflict.leftFactId)
      const right = factById.get(conflict.rightFactId)
      if (!left || !right) {
        return null
      }
      const insight = toMemoryConflictResponse({ conflict, left, right })
      if (insight.importance < HIGH_IMPACT_IMPORTANCE) {
        return null
      }
      return insight
    })
    .filter((conflict): conflict is MemoryConflictRecord => !!conflict)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8)

  return {
    unresolvedConflictIds,
    highImpactConflicts,
  }
}

function upsertFact(params: {
  thread: LocalMemoryThread
  fact: NonNullable<Parameters<UpsertMemoryFactsFn>[0]['facts']>[number]
}): { row: LocalMemoryFact; autoResolvedConflictIds: string[] } | null {
  const { thread, fact } = params
  const now = Date.now()

  const content = normalizeFactText(fact.content)
  if (!content) {
    return null
  }

  const factKey = normalizeFactKey(fact.key ?? content)
  if (!factKey) {
    return null
  }

  const factHash = hashString(`${factKey}::${content}`)

  let row = thread.facts.find((item) => item.factHash === factHash)
  if (row) {
    row.confidence = clamp0to100(fact.confidence, row.confidence)
    row.weight = clamp0to100(fact.weight, row.weight)
    row.tags = fact.tags ? [...fact.tags] : row.tags
    row.active = true
    row.lastSeenAt = now
    row.updatedAt = now
  } else {
    row = {
      id: crypto.randomUUID(),
      factKey,
      factHash,
      content,
      confidence: clamp0to100(fact.confidence, 72),
      weight: clamp0to100(fact.weight, 70),
      tags: fact.tags ? [...fact.tags] : [],
      active: true,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }
    thread.facts.push(row)
  }

  const peers = thread.facts
    .filter((item) => item.active && item.factKey === factKey)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)

  const autoResolvedConflictIds: string[] = []
  for (const peer of peers) {
    if (peer.id === row.id) continue
    if (normalizeFactText(peer.content) === normalizeFactText(row.content)) continue

    const [leftFactId, rightFactId] = [peer.id, row.id].sort()
    let conflict = thread.conflicts.find(
      (item) =>
        item.leftFactId === leftFactId &&
        item.rightFactId === rightFactId,
    )

    if (!conflict) {
      conflict = {
        id: crypto.randomUUID(),
        leftFactId,
        rightFactId,
        status: 'unresolved',
        reason: 'facts_with_same_key_disagree',
        createdAt: now,
        updatedAt: now,
      }
      thread.conflicts.push(conflict)
    } else if (conflict.status === 'resolved') {
      conflict.status = 'unresolved'
      conflict.reason = 'facts_with_same_key_disagree'
      conflict.updatedAt = now
      delete conflict.resolvedAt
    }

    const { shouldResolve, weakerFactId } = shouldAutoResolveConflict({
      left: peer,
      right: row,
    })
    if (shouldResolve) {
      const weaker = thread.facts.find((item) => item.id === weakerFactId)
      if (weaker) {
        weaker.active = false
        weaker.updatedAt = now
      }

      conflict.status = 'resolved'
      conflict.reason = 'auto_resolved_low_confidence'
      conflict.updatedAt = now
      conflict.resolvedAt = now
      autoResolvedConflictIds.push(conflict.id)
    }
  }

  return { row, autoResolvedConflictIds }
}

function queryFacts(params: {
  thread: LocalMemoryThread
  query: string | undefined
  limit: number
}): LocalMemoryFact[] {
  const { thread, query, limit } = params
  const queryTokens = tokenizeQuery(query)
  const now = Date.now()

  const facts = thread.facts
    .filter((fact) => fact.active)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 300)

  return facts
    .map((fact) => {
      const haystack = `${fact.factKey} ${fact.content}`.toLowerCase()
      const overlapCount = queryTokens.filter((token) =>
        haystack.includes(token),
      ).length
      const daysSinceUpdate = (now - fact.updatedAt) / (1000 * 60 * 60 * 24)
      const recencyBonus = Math.max(0, 20 - daysSinceUpdate)
      const score = fact.weight + fact.confidence + overlapCount * 25 + recencyBonus
      return { fact, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.fact)
}

export async function fetchMemoryFrameLocal(
  params: Parameters<FetchMemoryFrameFn>[0],
): ReturnType<FetchMemoryFrameFn> {
  const { apiKey, threadId, fingerprintId, logger } = params
  const store = readStore(logger)
  const bucket = ensureUserBucket(store, apiKey)
  const { thread, created } = findOrCreateThread({
    bucket,
    threadId,
    fingerprintId,
  })

  if (created) {
    writeStore(store, logger)
  }

  return toMemoryFrameResponse(thread)
}

export async function saveMemoryFrameLocal(
  params: Parameters<SaveMemoryFrameFn>[0],
): ReturnType<SaveMemoryFrameFn> {
  const {
    apiKey,
    threadId,
    fingerprintId,
    revision,
    frameHash,
    frameText,
    pinnedFactIds,
    unresolvedConflictIds,
    logger,
  } = params

  const store = readStore(logger)
  const bucket = ensureUserBucket(store, apiKey)
  const { thread } = findOrCreateThread({
    bucket,
    threadId,
    fingerprintId,
  })

  if (revision >= thread.latestRevision) {
    thread.fingerprintId = fingerprintId
    thread.latestRevision = revision
    thread.frameHash = frameHash
    thread.frameText = frameText
    if (pinnedFactIds) {
      thread.pinnedFactIds = [...pinnedFactIds]
    }
    if (unresolvedConflictIds) {
      thread.unresolvedConflictIds = [...unresolvedConflictIds]
    }
    thread.updatedAt = Date.now()
  }

  writeStore(store, logger)
  return toMemoryFrameResponse(thread)
}

export async function upsertMemoryFactsLocal(
  params: Parameters<UpsertMemoryFactsFn>[0],
): ReturnType<UpsertMemoryFactsFn> {
  const { apiKey, threadId, fingerprintId, facts, logger } = params
  const store = readStore(logger)
  const bucket = ensureUserBucket(store, apiKey)
  const { thread } = findOrCreateThread({
    bucket,
    threadId,
    fingerprintId,
  })

  const upsertedRows: LocalMemoryFact[] = []
  const autoResolvedConflictIds = new Set<string>()

  for (const fact of facts) {
    const result = upsertFact({ thread, fact })
    if (!result) {
      continue
    }
    upsertedRows.push(result.row)
    for (const conflictId of result.autoResolvedConflictIds) {
      autoResolvedConflictIds.add(conflictId)
    }
  }

  const { unresolvedConflictIds, highImpactConflicts } =
    collectConflictState(thread)
  thread.unresolvedConflictIds = unresolvedConflictIds
  thread.updatedAt = Date.now()

  writeStore(store, logger)

  return {
    threadId: thread.id,
    facts: upsertedRows.map(toMemoryFactResponse),
    unresolvedConflictIds,
    autoResolvedConflictIds: Array.from(autoResolvedConflictIds),
    highImpactConflicts,
  }
}

export async function queryMemoryFactsLocal(
  params: Parameters<QueryMemoryFactsFn>[0],
): ReturnType<QueryMemoryFactsFn> {
  const { apiKey, threadId, fingerprintId, query, limit, logger } = params
  const store = readStore(logger)
  const bucket = ensureUserBucket(store, apiKey)
  const { thread, created } = findOrCreateThread({
    bucket,
    threadId,
    fingerprintId,
  })
  const queryLimit = limit ?? 10

  const rankedFacts = queryFacts({
    thread,
    query,
    limit: queryLimit,
  })
  const { unresolvedConflictIds, highImpactConflicts } =
    collectConflictState(thread)

  if (created) {
    writeStore(store, logger)
  }

  return {
    threadId: thread.id,
    facts: rankedFacts.map(toMemoryFactResponse),
    unresolvedConflictIds,
    highImpactConflicts,
  }
}
