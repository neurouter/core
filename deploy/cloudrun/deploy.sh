#!/usr/bin/env bash
# Deploys Neurouter to Cloud Run (the read-only demo configuration). Reviewed and run by a human; never run by CI.
# Usage: GCP_PROJECT=<project> [GCP_REGION=europe-north1] TAG=<git-sha> PUBLIC_URL=https://neurouter-core-demo-<hash>.<region>.run.app \
#        OIDC_CLIENT_ID=... ADMIN_EMAIL=you@example.com ADMIN_DOMAIN=example.com ./deploy.sh
# First deploy: leave PUBLIC_URL empty, read the service URL from the output, then redeploy with it set.
set -euo pipefail
: "${TAG:?set TAG}" "${OIDC_CLIENT_ID:?set OIDC_CLIENT_ID}" "${ADMIN_EMAIL:?set ADMIN_EMAIL}" "${ADMIN_DOMAIN:?set ADMIN_DOMAIN}"
PUBLIC_URL="${PUBLIC_URL:-https://neurouter-core-demo.invalid}"
PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-europe-north1}"
SECRETS="DATABASE_URL=neurouter-core-database-url:latest,NEUROUTER_MASTER_KEYS=neurouter-core-master-keys:latest,NEUROUTER_ACTIVE_KEY_ID=neurouter-core-active-key-id:latest,HASH_PEPPER=neurouter-core-hash-pepper:latest,OIDC_CLIENT_SECRET=neurouter-core-oidc-client-secret:latest"
# model provider keys that setup.sh created (each optional)
for p in openai anthropic gemini; do
  if gcloud secrets describe "neurouter-core-$p-api-key" --project "$PROJECT" >/dev/null 2>&1; then
    SECRETS="$SECRETS,$(echo "$p" | tr '[:lower:]' '[:upper:]')_API_KEY=neurouter-core-$p-api-key:latest"
  fi
done
gcloud run deploy neurouter-core-demo \
  --project "$PROJECT" --region "$REGION" \
  --image "gcr.io/$PROJECT/neurouter-core:$TAG" \
  --service-account "neurouter-core-demo-sa@$PROJECT.iam.gserviceaccount.com" \
  --execution-environment gen2 --cpu 2 --memory 4Gi --no-cpu-throttling \
  --min-instances 1 --max-instances 1 --concurrency 80 --timeout 3600 --port 8080 \
  --add-cloudsql-instances "$PROJECT:$REGION:neurouter-core-pg" \
  --allow-unauthenticated \
  --set-env-vars "^@^NODE_ENV=production@PUBLIC_URL=$PUBLIC_URL@TRUST_PROXY=true@ORG_NAME=Neurouter demo@NEUROUTER_CONFIG=/app/examples/demo/neurouter.yaml@NEUROUTER_CONFIG_MODE=file@NEUROUTER_EXECUTOR_MODE=embedded@NEUROUTER_DEMO_READ_ONLY=true@NEUROUTER_PUBLIC_REPORTS=true@EMBEDDINGS_ALLOW_REMOTE=false@OTEL_SDK_DISABLED=true@OIDC_ISSUER=https://accounts.google.com@OIDC_CLIENT_ID=$OIDC_CLIENT_ID@BOOTSTRAP_ADMIN_EMAIL=$ADMIN_EMAIL@OIDC_ALLOWED_EMAIL_DOMAINS=$ADMIN_DOMAIN@NEUROUTER_LOCAL_LINK=false@MIGRATE_ON_START=true" \
  --set-secrets "$SECRETS"
# verify: curl $PUBLIC_URL/readyz ; curl $PUBLIC_URL/public/servers/github/badge.svg
