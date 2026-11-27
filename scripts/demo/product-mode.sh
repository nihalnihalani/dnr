#!/usr/bin/env bash
# P12-11: DNR product mode on the TypeScript demo repo (fixtures/ts-demo/pins.json) with the
# installed `dnr`. Usage: scripts/demo/product-mode.sh --repo "$TS_DEMO_SRC" [--dnr <bin>] [--out <dir>]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec pnpm --dir "$ROOT" -F dnr-guard exec tsx scripts/product-mode.ts "$@"
