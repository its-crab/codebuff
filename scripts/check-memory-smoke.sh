#!/usr/bin/env bash
set -euo pipefail

# App-only memory smoke check:
# 1) HYDRATE local thread from SDK local store
# 2) UPSERT_FACTS with a unique marker
# 3) QUERY_FACTS and assert marker is returned

ENV_NAME="${ENV_NAME:-dev}"
MARKER="${MARKER:-memory-smoke-local-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

if [[ -n "${CREDENTIALS_PATH:-}" ]]; then
  credentials_path="${CREDENTIALS_PATH}"
else
  if [[ "${ENV_NAME}" == "prod" ]]; then
    credentials_path="${HOME}/.config/manicode/credentials.json"
  else
    credentials_path="${HOME}/.config/manicode-${ENV_NAME}/credentials.json"
  fi
fi

if [[ -n "${CODEBUFF_API_KEY:-}" ]]; then
  token="${CODEBUFF_API_KEY}"
  fingerprint_id="${FINGERPRINT_ID:-cli-memory-smoke-${RANDOM}}"
else
  if [[ ! -f "${credentials_path}" ]]; then
    echo "error: credentials file not found: ${credentials_path}" >&2
    echo "hint: set CODEBUFF_API_KEY directly, or login once for env '${ENV_NAME}'." >&2
    exit 1
  fi

  token="$(jq -r '.default.authToken // empty' "${credentials_path}")"
  fingerprint_id="$(jq -r '.default.fingerprintId // empty' "${credentials_path}")"

  if [[ -z "${token}" ]]; then
    echo "error: missing .default.authToken in ${credentials_path}" >&2
    exit 1
  fi
fi

if [[ -z "${fingerprint_id}" ]]; then
  fingerprint_id="cli-memory-smoke-${RANDOM}"
  echo "warn: missing fingerprintId, using temporary: ${fingerprint_id}" >&2
fi

if [[ "${ENV_NAME}" == "prod" ]]; then
  config_suffix=""
else
  config_suffix="-${ENV_NAME}"
fi
store_path="${HOME}/.config/manicode${config_suffix}/memory-store.json"

echo "== Local Memory Smoke Check =="
echo "env_name=${ENV_NAME}"
echo "credentials=${credentials_path}"
echo "store=${store_path}"
echo "marker=${MARKER}"

SMOKE_API_KEY="${token}" \
SMOKE_FINGERPRINT_ID="${fingerprint_id}" \
SMOKE_MARKER="${MARKER}" \
SMOKE_ENV_NAME="${ENV_NAME}" \
bun -e "
const apiKey = process.env.SMOKE_API_KEY!
const fingerprintId = process.env.SMOKE_FINGERPRINT_ID!
const marker = process.env.SMOKE_MARKER!
const envName = process.env.SMOKE_ENV_NAME!

if (!process.env.NEXT_PUBLIC_CB_ENVIRONMENT) {
  process.env.NEXT_PUBLIC_CB_ENVIRONMENT = envName
}

const { fetchMemoryFrame, upsertMemoryFacts, queryMemoryFacts } = await import('./sdk/src/impl/database.ts')

const logger = {
  debug: () => {},
  info: () => {},
  warn: (obj: object, msg: string) => console.warn(msg, obj),
  error: (obj: object, msg: string) => console.error(msg, obj),
}

const frame = await fetchMemoryFrame({ apiKey, fingerprintId, logger })
if (!frame) {
  console.error('error: HYDRATE failed')
  process.exit(1)
}

const upsert = await upsertMemoryFacts({
  apiKey,
  fingerprintId,
  threadId: frame.threadId,
  facts: [
    {
      key: 'memory smoke marker',
      content: marker,
      confidence: 95,
      weight: 90,
      tags: ['diagnostic', 'smoke'],
    },
  ],
  logger,
})
if (!upsert || upsert.facts.length === 0) {
  console.error('error: UPSERT_FACTS failed')
  process.exit(1)
}

const queried = await queryMemoryFacts({
  apiKey,
  fingerprintId,
  threadId: frame.threadId,
  query: marker,
  limit: 10,
  logger,
})
if (!queried) {
  console.error('error: QUERY_FACTS failed')
  process.exit(1)
}

const found = queried.facts.some((fact) => fact.content.includes(marker))
if (!found) {
  console.error('error: QUERY_FACTS did not return inserted marker')
  console.error(JSON.stringify(queried, null, 2))
  process.exit(1)
}

console.log('hydrate.threadId=' + frame.threadId)
console.log('upsert.factId=' + upsert.facts[0]!.id)
console.log('query.results=' + queried.facts.length)
console.log('ok: local memory smoke check passed')
"
