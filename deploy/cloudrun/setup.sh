#!/usr/bin/env bash
# One-time GCP setup for the Neurouter Cloud Run demo (backend spec §20.6). Reviewed and run by a human.
# Creates NEW resources only: never touch the `neurouter` or `ai-gateway` services, their secrets, or ai-gateway-sa.
set -euo pipefail
PROJECT=helppo-ai
REGION=europe-north1
INSTANCE=neurouter-core-pg
SA=neurouter-core-demo-sa

gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com --project "$PROJECT"

# Cloud SQL: Postgres 17 (use 18 if offered), Enterprise, db-g1-small, 10 GB SSD, private-only via the connector, backups on
gcloud sql instances create "$INSTANCE" --project "$PROJECT" --region "$REGION" \
  --database-version POSTGRES_17 --edition ENTERPRISE --tier db-g1-small --storage-type SSD --storage-size 10 \
  --backup --no-assign-ip --enable-google-private-path 2>/dev/null || \
gcloud sql instances create "$INSTANCE" --project "$PROJECT" --region "$REGION" \
  --database-version POSTGRES_17 --edition ENTERPRISE --tier db-g1-small --storage-type SSD --storage-size 10 --backup
gcloud sql databases create neurouter --instance "$INSTANCE" --project "$PROJECT"
DB_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
gcloud sql users create neurouter --instance "$INSTANCE" --project "$PROJECT" --password "$DB_PASSWORD"
# pgvector: migration 0001 runs `CREATE EXTENSION vector;` (Cloud SQL supports it)

gcloud iam service-accounts create "$SA" --project "$PROJECT" --display-name "Neurouter core demo"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA@$PROJECT.iam.gserviceaccount.com" --role roles/cloudsql.client

put_secret() { printf '%s' "$2" | gcloud secrets create "$1" --project "$PROJECT" --replication-policy automatic --data-file=- ; \
  gcloud secrets add-iam-policy-binding "$1" --project "$PROJECT" --member "serviceAccount:$SA@$PROJECT.iam.gserviceaccount.com" --role roles/secretmanager.secretAccessor >/dev/null; }

KEYS="$(npx -y neurouter keys gen 2>/dev/null || node -e "const c=require('crypto');console.log('NEUROUTER_MASTER_KEYS=k1:'+c.randomBytes(32).toString('base64')+'\nNEUROUTER_ACTIVE_KEY_ID=k1\nHASH_PEPPER='+c.randomBytes(48).toString('base64url'))")"
put_secret neurouter-core-database-url "postgres://neurouter:${DB_PASSWORD}@/neurouter?host=/cloudsql/${PROJECT}:${REGION}:${INSTANCE}"
put_secret neurouter-core-master-keys "$(echo "$KEYS" | sed -n 's/^NEUROUTER_MASTER_KEYS=//p')"
put_secret neurouter-core-active-key-id "$(echo "$KEYS" | sed -n 's/^NEUROUTER_ACTIVE_KEY_ID=//p')"
put_secret neurouter-core-hash-pepper "$(echo "$KEYS" | sed -n 's/^HASH_PEPPER=//p')"
read -r -s -p "OIDC client secret (Google OAuth client 'Neurouter demo'): " OIDC_SECRET; echo
put_secret neurouter-core-oidc-client-secret "$OIDC_SECRET"
read -r -s -p "Anthropic API key (BYOK, for evals): " ANTHROPIC_KEY; echo
put_secret neurouter-core-anthropic-api-key "$ANTHROPIC_KEY"
echo "done. Build: gcloud builds submit --project $PROJECT --region $REGION --tag gcr.io/$PROJECT/neurouter-core:\$TAG --machine-type e2-highcpu-8 --timeout 40m ."
