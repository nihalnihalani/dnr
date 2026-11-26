#!/usr/bin/env bash
# Sets up ../django-demo for a live DNR block in Kiro (plan Phase 0, §10, §11).
#
#   1. Clones Django from $DJANGO_SRC (--no-local) or from GitHub, into ../django-demo,
#      and checks out the demo revert 43933a1dca.
#   2. Builds the §9.1 step 6 uv environment, outside the checkout.
#   3. Runs `dnr init --hooks all` and installs the bundled approved demo orders
#      from fixtures/demo-orders/ (each step is skipped with a notice until it exists).
#   4. Prints the kiro-cli login step and the ready prompts.
#
# Usage: scripts/demo/make-demo-checkout.sh [--no-verify]
#   --no-verify  skip the `tests/runtests.py aggregation_regress` check
set -euo pipefail

DEMO_REVERT=43933a1dca
DEMO_ORDERS=(dnr-43933a1dca dnr-d0e4dd5cdd)
DJANGO_URL=https://github.com/django/django

VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "make-demo-checkout: unknown argument: $arg" >&2; exit 64 ;;
  esac
done

note() { printf 'make-demo-checkout: %s\n' "$*" >&2; }
die() { printf 'make-demo-checkout: error: %s\n' "$*" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH" 69; }

need git
need uv
need jq

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PARENT="$(cd "$ROOT/.." && pwd -P)"
DEMO="$PARENT/django-demo"
# The environment lives outside the checkout, so `git status` in the demo stays clean
# (gate check 1b diffs the whole working tree).
ENV_DIR="$PARENT/django-demo-env"

# 1. Clone and check out the demo revert.
if [ -d "$DEMO/.git" ]; then
  note "reusing existing checkout $DEMO (not reset; remove it to start fresh)"
else
  [ -e "$DEMO" ] && die "$DEMO exists and is not a git checkout"
  if [ -n "${DJANGO_SRC:-}" ]; then
    note "cloning $DJANGO_SRC into $DEMO"
    git clone --no-local "$DJANGO_SRC" "$DEMO"
  else
    note "DJANGO_SRC is unset; cloning $DJANGO_URL into $DEMO"
    git clone "$DJANGO_URL" "$DEMO"
  fi
fi
git -C "$DEMO" rev-parse --verify --quiet "$DEMO_REVERT^{commit}" >/dev/null \
  || die "commit $DEMO_REVERT is not in $DEMO"
if [ "$(git -C "$DEMO" rev-parse HEAD)" != "$(git -C "$DEMO" rev-parse "$DEMO_REVERT^{commit}")" ]; then
  [ -z "$(git -C "$DEMO" status --porcelain)" ] || die "$DEMO has uncommitted changes; refusing to switch commits"
  git -C "$DEMO" checkout -q -B dnr-demo "$DEMO_REVERT"
fi
note "checkout at $(git -C "$DEMO" rev-parse --short=10 HEAD)"

# 2. Python environment (§9.1 step 6): version from the checkout's metadata, packages
#    no newer than the revert's commit date, no `-e .`; tests run with PYTHONPATH.
python_version() {
  local v=""
  if [ -f "$DEMO/pyproject.toml" ]; then
    v="$(sed -nE 's/^[[:space:]]*requires-python[[:space:]]*=[[:space:]]*"[[:space:]]*>=[[:space:]]*([0-9]+\.[0-9]+).*/\1/p' "$DEMO/pyproject.toml" | head -n1)"
  fi
  if [ -z "$v" ] && [ -f "$DEMO/setup.cfg" ]; then
    v="$(sed -nE 's/^[[:space:]]*python_requires[[:space:]]*=[[:space:]]*>=[[:space:]]*([0-9]+\.[0-9]+).*/\1/p' "$DEMO/setup.cfg" | head -n1)"
  fi
  if [ -z "$v" ] && [ -f "$DEMO/setup.py" ]; then
    v="$(sed -nE "s/.*python_requires[[:space:]]*=[[:space:]]*['\"]>=[[:space:]]*([0-9]+\.[0-9]+).*/\1/p" "$DEMO/setup.py" | head -n1)"
  fi
  if [ -z "$v" ] && [ -f "$ROOT/fixtures/django-python.json" ]; then
    local djver
    djver="$(sed -nE 's/^VERSION = \(([0-9]+), ([0-9]+),.*/\1.\2/p' "$DEMO/django/__init__.py" | head -n1)"
    v="$(jq -r --arg v "$djver" '.[$v] // empty' "$ROOT/fixtures/django-python.json")"
  fi
  printf '%s' "$v"
}
PY="$(python_version)"
[ -n "$PY" ] || die "could not determine the Python version for $DEMO_REVERT"
R_DATE="$(git -C "$DEMO" log -1 --format=%cI HEAD)"
if [ ! -x "$ENV_DIR/bin/python" ]; then
  note "creating Python $PY environment at $ENV_DIR (packages as of $R_DATE)"
  uv venv -p "$PY" "$ENV_DIR"
  uv pip install --python "$ENV_DIR" --exclude-newer "$R_DATE" -r "$DEMO/tests/requirements/py3.txt"
else
  note "reusing environment $ENV_DIR"
fi
if [ "$VERIFY" = 1 ]; then
  note "verifying: tests/runtests.py aggregation_regress"
  (cd "$DEMO" && PYTHONPATH="$DEMO" "$ENV_DIR/bin/python" tests/runtests.py aggregation_regress)
fi

# 3. DNR hooks and the bundled demo orders.
if command -v dnr >/dev/null 2>&1; then
  note "installing DNR hooks: dnr init --hooks all"
  (cd "$DEMO" && dnr init --hooks all)
  missing=0
  for id in "${DEMO_ORDERS[@]}"; do
    [ -f "$ROOT/fixtures/demo-orders/$id.json" ] || missing=1
  done
  if [ "$missing" = 1 ]; then
    note "fixtures/demo-orders/ is not filled yet (Phase 8); skipping the demo orders"
  else
    mkdir -p "$DEMO/.dnr/orders"
    for id in "${DEMO_ORDERS[@]}"; do
      cp "$ROOT/fixtures/demo-orders/$id.json" "$DEMO/.dnr/orders/$id.json"
      status="$(jq -r .status "$DEMO/.dnr/orders/$id.json")"
      [ "$status" = approved ] || die "$id has status '$status', expected 'approved'"
    done
    (cd "$DEMO" && dnr orders list)
    for id in "${DEMO_ORDERS[@]}"; do
      (cd "$DEMO" && dnr orders list) | grep -F "$id" | grep -qF approved \
        || die "dnr orders list does not show $id as approved"
    done
    note "both demo orders installed and approved"
  fi
else
  note "dnr is not on PATH yet (the hook phases build it); skipping dnr init and the demo orders"
fi

# 4. Next steps for the human.
cat <<NEXT

Demo checkout ready: $DEMO
Python environment:  $ENV_DIR

Log in to Kiro once (opens a browser):
  kiro-cli login

Trigger the live block (write.txt always reaches the hook):
  cd "$DEMO" && kiro-cli chat "\$(cat "$ROOT/scripts/demo/prompts/write.txt")"

Alternates: scripts/demo/prompts/direct.txt (the direct request) and
scripts/demo/prompts/cleanup.txt (the cleanup task).

Run the tests the way the trial does:
  cd "$DEMO" && PYTHONPATH="\$PWD" "$ENV_DIR/bin/python" tests/runtests.py aggregation_regress
NEXT
