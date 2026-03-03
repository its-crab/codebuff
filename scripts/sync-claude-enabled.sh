#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEBUFF_BIN_LINK="${HOME}/.npm-global/bin/codebuff"
FEATURE_FLAG_FILE="common/src/constants/claude-oauth.ts"
FEATURE_FLAG_LINE='export const CLAUDE_OAUTH_ENABLED = true'

cd "${REPO_DIR}"

git checkout claude-enabled
git fetch upstream
git rebase upstream/main

# Ensure Claude OAuth stays enabled even if upstream changed the flag.
if ! rg -q "CLAUDE_OAUTH_ENABLED = true" "${FEATURE_FLAG_FILE}"; then
  sed -i "s/export const CLAUDE_OAUTH_ENABLED = false/${FEATURE_FLAG_LINE}/" "${FEATURE_FLAG_FILE}"
  git add "${FEATURE_FLAG_FILE}"
  git commit -m "Keep Claude OAuth feature flag enabled"
fi

git push --force-with-lease origin claude-enabled

NEXT_PUBLIC_CB_ENVIRONMENT=prod \
NEXT_PUBLIC_CODEBUFF_APP_URL=https://www.codebuff.com \
NEXT_PUBLIC_SUPPORT_EMAIL=support@codebuff.com \
NEXT_PUBLIC_POSTHOG_API_KEY='phc_tug7g8yc10qNestK14QV8WyKwjfEl6vwzIbJkBdqeHS' \
NEXT_PUBLIC_POSTHOG_HOST_URL=https://us.i.posthog.com \
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY='pk_live_51Q0SA5KrNS6SjmqWMgRE0ar5v6cMvtizkyY3mXjYaZsU6AG9ctpNPKZMVf6xFK2ngqwkt8rHNIQgNiCFSbRdGb9Z00QEo13rfx' \
NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL='https://billing.stripe.com/p/login/cN22bea8W6Ra2is144' \
NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID='your google verification id' \
NEXT_PUBLIC_WEB_PORT=3000 \
bun run --cwd=cli build:binary

mkdir -p "$(dirname "${CODEBUFF_BIN_LINK}")"
ln -sfn "${REPO_DIR}/cli/bin/codebuff" "${CODEBUFF_BIN_LINK}"

echo "Done: synced, pushed, rebuilt, and linked ${CODEBUFF_BIN_LINK} -> ${REPO_DIR}/cli/bin/codebuff"
