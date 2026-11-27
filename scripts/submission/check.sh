#!/usr/bin/env bash
# Submission checker (plan §11 submission checklist, acceptance rows SUB-01…SUB-08, VID-05,
# WRITE-03, P14-01…P14-03). Checks every item a script can check against the real world:
# GitHub (gh), the live Playground (curl and the @smoke Playwright test), YouTube oEmbed,
# ffprobe, and the repo's own files. Prints PASS, FAIL or PENDING per item; exits 1 on any FAIL.
#
#   scripts/submission/check.sh [--report docs/submission/status.md] [--no-smoke]
#
# Inputs: docs/submission/links.json (URLs filled in by the maintainer as they go live),
# VIDEO_FILE=<final cut> for ffprobe, REPO=<owner/name> (default nihalnihalani/dnr), and
# PW_CHANNEL=chrome to run the @smoke test on an installed Google Chrome instead of Playwright's.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
REPO="${REPO:-nihalnihalani/dnr}"
LINKS="docs/submission/links.json"
REPORT=""
SMOKE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --no-smoke) SMOKE=0; shift ;;
    *) echo "usage: $0 [--report FILE] [--no-smoke]" >&2; exit 2 ;;
  esac
done

ROWS=()
FAILS=0
row() { # status id item detail
  ROWS+=("$1|$2|$3|$4")
  [ "$1" = FAIL ] && FAILS=$((FAILS + 1))
  printf '%-7s %-8s %s: %s\n' "$1" "$2" "$3" "$4"
}
link() { jq -r --arg k "$1" '.[$k] // empty' "$LINKS" 2>/dev/null; }
http() { curl -sL --max-time 30 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }
tsx() { pnpm -s exec tsx "$@"; }

for t in gh git curl jq pnpm; do
  command -v "$t" >/dev/null || { echo "check.sh: $t is not installed" >&2; exit 2; }
done

# --- SUB-01: video under 3 minutes, public on YouTube -----------------------------------------
VIDEO_URL="$(link video_url)"
if [ -z "$VIDEO_URL" ]; then
  row PENDING SUB-01 "Video public on YouTube" "video_url is not set in $LINKS (not uploaded yet)"
else
  code=$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' --get --data-urlencode "url=$VIDEO_URL" \
    --data-urlencode format=json https://www.youtube.com/oembed)
  if [ "$code" = 200 ]; then row PASS SUB-01 "Video public on YouTube" "oEmbed 200 for $VIDEO_URL"
  else row FAIL SUB-01 "Video public on YouTube" "oEmbed returned $code for $VIDEO_URL (private, removed or not YouTube)"; fi
fi
if [ -n "${VIDEO_FILE:-}" ]; then
  out=$(tsx scripts/video/check.ts --video "$VIDEO_FILE" 2>&1 | grep ' ffprobe: ')
  case "$out" in
    PASS*) row PASS VID-01 "Video under 3:00 (ffprobe)" "${out#*ffprobe: }" ;;
    *) row FAIL VID-01 "Video under 3:00 (ffprobe)" "${out#*ffprobe: }" ;;
  esac
elif [ -n "$VIDEO_URL" ] && command -v yt-dlp >/dev/null; then
  d=$(yt-dlp --skip-download --print duration "$VIDEO_URL" 2>/dev/null)
  if [ -n "$d" ] && [ "$d" -lt 180 ]; then row PASS VID-01 "Video under 3:00" "YouTube reports ${d} s"
  else row FAIL VID-01 "Video under 3:00" "YouTube reports '${d}' s"; fi
else
  row PENDING VID-01 "Video under 3:00 (ffprobe)" "no final cut: set VIDEO_FILE=<file> to run ffprobe"
fi

# --- SUB-02: repo public, MIT license detectable ------------------------------------------------
if j=$(gh repo view "$REPO" --json visibility,licenseInfo 2>/dev/null); then
  vis=$(jq -r .visibility <<<"$j"); lic=$(jq -r '.licenseInfo.key // "none"' <<<"$j")
  [ "$vis" = PUBLIC ] && row PASS SUB-02 "Repo is public" "$REPO is $vis" || row FAIL SUB-02 "Repo is public" "$REPO is $vis"
  [ "$lic" = mit ] && row PASS SUB-02 "License is MIT (About panel)" "GitHub detects $lic" \
    || row FAIL SUB-02 "License is MIT (About panel)" "GitHub detects '$lic'"
else
  row FAIL SUB-02 "Repo is public, MIT" "gh repo view $REPO failed (not logged in, or no such repo)"
fi

# --- SUB-03: .kiro tracked, not ignored ------------------------------------------------------------
n=$(git ls-files .kiro | wc -l | tr -d ' ')
[ "$n" -gt 0 ] && row PASS SUB-03 "git ls-files .kiro is non-empty" "$n tracked files" \
  || row FAIL SUB-03 "git ls-files .kiro is non-empty" "no tracked files under .kiro/"
ign=$(git check-ignore -v --no-index .kiro .kiro/steering/product.md .kiro/hooks/dnr-pre-write.json 2>&1); ic=$?
if [ $ic -eq 0 ]; then row FAIL SUB-03 ".kiro is not gitignored" "$(head -1 <<<"$ign")"
elif [ $ic -eq 1 ]; then row PASS SUB-03 ".kiro is not gitignored" "git check-ignore matches none of .kiro, .kiro/steering/product.md, .kiro/hooks/dnr-pre-write.json"
else row FAIL SUB-03 ".kiro is not gitignored" "git check-ignore failed: $ign"; fi

# --- SUB-04: Playground works without a login; /play block; deep links -------------------------
PG="$(link playground_url)"
if [ -z "$PG" ]; then
  row PENDING SUB-04 "Playground URL returns 200, no login" "playground_url is not set in $LINKS"
else
  PG="${PG%/}/"
  body=$(curl -sL --max-time 30 -w '\n%{http_code} %{url_effective}' "$PG")
  last=$(tail -n1 <<<"$body"); code=${last%% *}; eff=${last#* }
  if [ "$code" != 200 ]; then row FAIL SUB-04 "Playground URL returns 200, no login" "$PG returned $code"
  elif [ "$(cut -d/ -f3 <<<"$eff")" != "$(cut -d/ -f3 <<<"$PG")" ]; then
    row FAIL SUB-04 "Playground URL returns 200, no login" "redirected to $eff"
  elif grep -qi 'type="password"' <<<"$body"; then row FAIL SUB-04 "Playground URL returns 200, no login" "the page asks for a password"
  else row PASS SUB-04 "Playground URL returns 200, no login" "$PG → 200, no redirect off-site, no password field"; fi

  if [ "$SMOKE" = 1 ]; then
    if log=$(PLAYGROUND_URL="$PG" pnpm -s -F @dnr/playground exec playwright test --grep @smoke --project=chromium --reporter=line 2>&1); then
      row PASS SUB-04 "/play block works (@smoke, Chromium)" "$(grep -Eo '[0-9]+ passed' <<<"$log" | tail -1) against $PG${PW_CHANNEL:+ (channel $PW_CHANNEL)}"
    else row FAIL SUB-04 "/play block works (@smoke, Chromium)" "$(grep -E 'failed|Error' <<<"$log" | head -2 | tr '\n' ' ')"; fi
  else
    row PENDING SUB-04 "/play block works (@smoke, Chromium)" "not run (--no-smoke)"
  fi

  bad=""
  for p in play/43933a1dca graveyard trial replay kiro orders/dnr-43933a1dca; do
    c=$(http "$PG$p"); [ "$c" = 200 ] || bad="$bad $p→$c"
  done
  [ -z "$bad" ] && row PASS SUB-04 "Deep links return 200" "/play/43933a1dca /graveyard /trial /replay /kiro /orders/dnr-43933a1dca" \
    || row FAIL SUB-04 "Deep links return 200" "$bad"
fi

# --- SUB-05: README#testing ------------------------------------------------------------------------
grep -q '^## Testing$' README.md && row PASS SUB-05 "README.md#testing is present" "README.md:$(grep -n '^## Testing$' README.md | cut -d: -f1)" \
  || row FAIL SUB-05 "README.md#testing is present" "no '## Testing' heading in README.md"

# --- SUB-06: category (Devpost form) --------------------------------------------------------------
row PENDING SUB-06 "Category: Frankenstein" "chosen in the Devpost form by the maintainer; not scriptable"

# --- SUB-08: every claim links to a file that exists ------------------------------------------------
if out=$(tsx scripts/submission/verify.ts links README.md docs/kiro-usage.md docs/submission/devpost.md docs/submission/pitch.md 2>&1); then
  row PASS SUB-08 "Every link in the README and write-up resolves" "$out"
else row FAIL SUB-08 "Every link in the README and write-up resolves" "$(head -3 <<<"$out" | tr '\n' ';')"; fi

# --- WRITE-03 / VID-05: generated text is current; the video checker ---------------------------------
if tsx scripts/submission/generate.ts --check >/dev/null 2>&1; then
  pend=$(cat docs/submission/pitch.md docs/submission/devpost.md | grep -Eo '\*\*Pending:\*\*|\[pending: ' | wc -l | tr -d ' ')
  if [ "$pend" -gt 0 ]; then row PENDING WRITE-03 "Pitch and write-up generated from numbers.json" "current, with $pend pending item(s)"
  else row PASS WRITE-03 "Pitch and write-up generated from numbers.json" "current, nothing pending"; fi
else row FAIL WRITE-03 "Pitch and write-up generated from numbers.json" "docs/submission is stale: run scripts/submission/generate.ts"; fi
vout=$(tsx scripts/video/check.ts 2>&1); vcode=$?
if [ $vcode -ne 0 ]; then row FAIL VID-05 "Video captions checker" "$(grep '^FAIL' <<<"$vout" | head -2 | tr '\n' ';')"
elif grep -q '^PENDING' <<<"$vout"; then row PENDING VID-05 "Video captions checker" "$(grep '^PENDING' <<<"$vout" | head -1 | sed 's/^PENDING *//')"
else row PASS VID-05 "Video captions checker" "every check passes"; fi

# --- SUB-07: bonus entries (Phase 0 record in docs/spikes.md) -----------------------------------------
rec=$(grep -E '^\| Bonus eligibility' docs/spikes.md | awk -F'|' '{print $3}' | sed 's/^ *//;s/ *$//')
if [ -z "$rec" ]; then row FAIL SUB-07 "Bonus eligibility recorded (Phase 0)" "no 'Bonus eligibility' row in docs/spikes.md"
elif grep -qi '^pending' <<<"$rec"; then row PENDING SUB-07 "Bonus eligibility recorded (Phase 0)" "$rec"
else row PASS SUB-07 "Bonus eligibility recorded (Phase 0)" "$rec"; fi

CREW="$(link crew_repo)"
if [ -z "$CREW" ]; then row PENDING P14-03 "Crew bonus: separate public repo with .kiro" "crew_repo is not set in $LINKS (dnr-crew is local-only)"
else
  slug=$(sed -E 's#https://github.com/##; s#/$##' <<<"$CREW")
  vis=$(gh repo view "$slug" --json visibility -q .visibility 2>/dev/null)
  kiro=$(gh api "repos/$slug/contents/.kiro" -q 'length' 2>/dev/null || echo 0)
  if [ "$vis" = PUBLIC ] && [ "${kiro:-0}" -gt 0 ]; then row PASS P14-03 "Crew bonus: separate public repo with .kiro" "$slug is public with .kiro/"
  else row FAIL P14-03 "Crew bonus: separate public repo with .kiro" "$slug: visibility '${vis:-unknown}', .kiro entries ${kiro:-0}"; fi
fi

DEVTO="$(link devto_url)"
if [ -z "$DEVTO" ]; then
  [ -f docs/submission/devto-draft.md ] && row PENDING P14-01 "Blog: dev.to post published" "draft in docs/submission/devto-draft.md; devto_url not set (not published)" \
    || row FAIL P14-01 "Blog: dev.to post published" "no draft and no devto_url"
else
  c=$(http "$DEVTO"); [ "$c" = 200 ] && row PASS P14-01 "Blog: dev.to post published" "$DEVTO → 200" || row FAIL P14-01 "Blog: dev.to post published" "$DEVTO → $c"
fi

if out=$(tsx scripts/submission/verify.ts social docs/submission/social-drafts.md 2>&1); then
  row PASS P14-02 "Social drafts start with #KiroweenHackathon26" "$out"
else row FAIL P14-02 "Social drafts start with #KiroweenHackathon26" "$(head -2 <<<"$out" | tr '\n' ';')"; fi
for k in x_url linkedin_url; do
  u="$(link $k)"
  [ -z "$u" ] && row PENDING P14-02 "Social post live ($k)" "$k is not set in $LINKS (not posted)" \
    || row PASS P14-02 "Social post live ($k)" "$u (set by the maintainer)"
done

# --- Summary and report ---------------------------------------------------------------------------
P=0; F=0; W=0
for r in "${ROWS[@]}"; do case "${r%%|*}" in PASS) P=$((P+1));; FAIL) F=$((F+1));; PENDING) W=$((W+1));; esac; done
echo "submission check: $P PASS, $F FAIL, $W PENDING"
if [ -n "$REPORT" ]; then
  {
    echo "# Submission status"
    echo
    echo "Output of \`scripts/submission/check.sh\` (plan §11 submission checklist), run $(date -u +%Y-%m-%dT%H:%MZ) at \`$(git rev-parse --short HEAD)\`. Re-run it to refresh this file; it exits non-zero on any FAIL."
    echo
    echo "**$P PASS, $F FAIL, $W PENDING.**"
    echo
    echo "| Status | Row | Item | Detail |"
    echo "|---|---|---|---|"
    for r in "${ROWS[@]}"; do
      IFS='|' read -r s id item detail <<<"$r"
      echo "| $s | $id | $item | ${detail//|/\\|} |"
    done
  } >"$REPORT"
  echo "submission check: wrote $REPORT"
fi
[ "$FAILS" -eq 0 ]
