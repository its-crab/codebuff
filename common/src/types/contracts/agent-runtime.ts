import type { TrackEventFn } from './analytics'
import type { ConsumeCreditsWithFallbackFn } from './billing'
import type {
  HandleStepsLogChunkFn,
  RequestFilesFn,
  RequestMcpToolDataFn,
  RequestOptionalFileFn,
  RequestToolCallFn,
  SendActionFn,
  SendSubagentChunkFn,
} from './client'
import type {
  AddAgentStepFn,
  DatabaseAgentCache,
  FetchMemoryFrameFn,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  GetUserInfoFromApiKeyFn,
  QueryMemoryFactsFn,
  SaveMemoryFrameFn,
  StartAgentRunFn,
  UpsertMemoryFactsFn,
} from './database'
import type { ClientEnv, CiEnv } from './env'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredFn,
} from './llm'
import type { Logger } from './logger'

/** Shared dependencies */
export type AgentRuntimeDeps = {
  // Environment
  clientEnv: ClientEnv
  ciEnv: CiEnv

  // Database
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
  startAgentRun: StartAgentRunFn
  finishAgentRun: FinishAgentRunFn
  addAgentStep: AddAgentStepFn
  fetchMemoryFrame?: FetchMemoryFrameFn
  saveMemoryFrame?: SaveMemoryFrameFn
  upsertMemoryFacts?: UpsertMemoryFactsFn
  queryMemoryFacts?: QueryMemoryFactsFn

  // Billing
  consumeCreditsWithFallback: ConsumeCreditsWithFallbackFn

  // LLM
  promptAiSdkStream: PromptAiSdkStreamFn
  promptAiSdk: PromptAiSdkFn
  promptAiSdkStructured: PromptAiSdkStructuredFn

  // Mutable State
  databaseAgentCache: DatabaseAgentCache

  // Analytics
  trackEvent: TrackEventFn

  // Other
  logger: Logger
  fetch: typeof globalThis.fetch
}

/** Per-run dependencies */
export type AgentRuntimeScopedDeps = {
  // Client (WebSocket)
  handleStepsLogChunk: HandleStepsLogChunkFn
  requestToolCall: RequestToolCallFn
  requestMcpToolData: RequestMcpToolDataFn
  requestFiles: RequestFilesFn
  requestOptionalFile: RequestOptionalFileFn
  sendAction: SendActionFn
  sendSubagentChunk: SendSubagentChunkFn

  apiKey: string
}
