#!/bin/sh
# Exports the Monty worker binary pinned at build time (path + sha256, §10.6), then runs the command.
#   docker run <image>                    the server (CMD)
#   docker run <image> migrate [up|status] database migrations only (a deploy step: Cloud Run job, Helm Job);
#                                         needs only DATABASE_URL (+ AUDIT_DATABASE_URL); run the service with MIGRATE_ON_START=false
set -e
if [ "$1" = "migrate" ]; then
  shift
  [ $# -gt 0 ] || set -- up
  exec node apps/server/dist/scripts/migrate.js "$@"
fi
if [ -z "$MONTY_BINARY_PATH" ] && [ -f /app/monty-path ]; then MONTY_BINARY_PATH="$(cat /app/monty-path)"; export MONTY_BINARY_PATH; fi
if [ -z "$MONTY_BINARY_SHA256" ] && [ -f /app/monty-sha256 ]; then MONTY_BINARY_SHA256="$(cat /app/monty-sha256)"; export MONTY_BINARY_SHA256; fi
exec "$@"
