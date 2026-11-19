#!/usr/bin/env bash
# Read-only preflight before a live Twitch test. Prints one PASS or FAIL line per check and exits
# non-zero if any check fails. It only sends GET requests to the local ComicToons API and web server.
# Ports: COMICTOONS_API_PORT (default 3001) and COMICTOONS_WEB_PORT (default 4173), as the app reads them.
# Usage: scripts/preflight-live.sh   or   COMICTOONS_API_PORT=3120 COMICTOONS_WEB_PORT=4120 scripts/preflight-live.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
if ! command -v node >/dev/null 2>&1; then echo "FAIL node: node is not on PATH (use Node 20)"; exit 2; fi
exec node --import tsx scripts/preflight-live.ts "$@"
