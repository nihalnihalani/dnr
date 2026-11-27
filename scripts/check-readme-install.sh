#!/usr/bin/env bash
# Production audit P1: run the README Quick start install block exactly as written, so the docs
# cannot drift. The block is the fenced code between <!-- readme-install --> markers in README.md.
# npm's global prefix is a temp dir, so nothing outside it changes. Then `dnr` must be on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
block="$(awk '/<!-- readme-install -->/{f=1;next} /<!-- \/readme-install -->/{f=0} f' README.md | sed '/^```/d')"
[ -n "$block" ] || { echo "check-readme-install: no <!-- readme-install --> block in README.md" >&2; exit 1; }
prefix="$(mktemp -d)"
trap 'rm -rf "$prefix" ./dnr-guard-*.tgz' EXIT
export npm_config_prefix="$prefix"
export PATH="$prefix/bin:$PATH"
echo "check-readme-install: running the README block:"
printf '  %s\n' "$block"
bash -euo pipefail -c "$block"
command -v dnr >/dev/null || { echo "check-readme-install: dnr is not on PATH after the README install" >&2; exit 1; }
want="$(node -p "require('./packages/cli/package.json').version")"
got="$(dnr --version)"
[ "$got" = "$want" ] || { echo "check-readme-install: dnr --version printed '$got', want '$want'" >&2; exit 1; }
case "$(command -v dnr)" in "$prefix"/*) ;; *) echo "check-readme-install: dnr resolved outside the temp prefix" >&2; exit 1;; esac
echo "check-readme-install: ok (dnr $got from $(command -v dnr))"
