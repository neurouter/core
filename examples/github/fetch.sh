#!/usr/bin/env bash
# Downloads the full GitHub REST API description (≈ 11 MB, kept out of git) pinned to the tag in SOURCE.md.
set -euo pipefail
cd "$(dirname "$0")"
TAG=v2.1.0
mkdir -p spec
curl -fsSL -o spec/api.github.com.json "https://raw.githubusercontent.com/github/rest-api-description/${TAG}/descriptions/api.github.com/api.github.com.json"
echo "wrote spec/api.github.com.json ($(wc -c < spec/api.github.com.json) bytes)"
