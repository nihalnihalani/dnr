#!/bin/sh
# dnr-trial-agent: the root-owned launcher for `dnr trial run --isolation os-user` (§9.3 isolation
# amendment). Installed once by a human:
#   sudo install -o root -g wheel -m 0755 scripts/trial/dnr-trial-agent.sh /usr/local/libexec/dnr-trial-agent
# and allowed for the harness user only, as the agent user only:
#   <harness-user> ALL=(dnrtrial) NOPASSWD: /usr/local/libexec/dnr-trial-agent
#
#   dnr-trial-agent check                       exit 0 (sudoers works)
#   dnr-trial-agent probe rw|none <path>        exit 0 if the agent user can use / cannot read <path>
#   dnr-trial-agent run <trial_root> <workdir> <home> <kiro-cli> -- <args…>
set -u
case "${1:-}" in
check) exit 0 ;;
probe)
  want=$2
  p=$3
  if [ "$want" = rw ]; then
    [ -r "$p" ] && [ -w "$p" ] && [ -x "$p" ]
    exit $?
  fi
  if ls "$p" >/dev/null 2>&1 || cat "$p" >/dev/null 2>&1; then exit 1; fi
  exit 0
  ;;
run)
  shift
  root=$1 wd=$2 home=$3 kiro=$4
  shift 4
  [ "${1:-}" = -- ] && shift
  case "$wd$home" in *..*) echo "dnr-trial-agent: '..' in a path" >&2; exit 64 ;; esac
  case "$wd" in "$root"/runs/*) ;; *) echo "dnr-trial-agent: workdir is not under $root/runs" >&2; exit 64 ;; esac
  case "$home" in "$root"/homes/*) ;; *) echo "dnr-trial-agent: home is not under $root/homes" >&2; exit 64 ;; esac
  cd "$wd" || exit 69
  # The harness's timer reaches us through sudo; take the whole process group down with us.
  trap 'kill -KILL 0' TERM INT HUP
  env -i HOME="$home" PATH=/usr/local/bin:/usr/bin:/bin USER="$(id -un)" LANG=en_US.UTF-8 "$kiro" "$@" &
  wait $!
  ;;
*)
  echo "usage: dnr-trial-agent check | probe rw|none <path> | run <trial_root> <workdir> <home> <kiro-cli> -- <args>" >&2
  exit 64
  ;;
esac
