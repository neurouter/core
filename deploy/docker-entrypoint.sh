#!/bin/sh
# Exports the Monty worker binary pinned at build time (path + sha256, §10.6), then runs the command.
set -e
if [ -z "$MONTY_BINARY_PATH" ] && [ -f /app/monty-path ]; then MONTY_BINARY_PATH="$(cat /app/monty-path)"; export MONTY_BINARY_PATH; fi
if [ -z "$MONTY_BINARY_SHA256" ] && [ -f /app/monty-sha256 ]; then MONTY_BINARY_SHA256="$(cat /app/monty-sha256)"; export MONTY_BINARY_SHA256; fi
exec "$@"
