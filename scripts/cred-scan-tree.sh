#!/usr/bin/env bash
#
# cred-scan-tree.sh — scan a whole DIRECTORY TREE for credential-shaped literals.
#
# Used by publish-sync.sh on the assembled public tree. Separate from credscan.sh,
# which scans git-TRACKED files in a repo; this one walks a filesystem tree that
# has no index yet.
#
# Exit status is the whole interface, so the caller can tell the three cases apart:
#   0  clean
#   1  credential material found — file NAMES printed on stdout, never the matched
#      line, so a real secret is never echoed into a log
#   2  cannot verify (unreadable path, bad usage) — the caller must FAIL CLOSED
#
# It lives in its own file because the rc=2 path has to be testable: the caller
# used to swallow it with `|| true`, which turned "I could not look" into "nothing
# to see" (#65). Reproducing that needs an unreadable directory, which a test can
# build here and cannot inject into a staging run.
#
set -uo pipefail   # NOT -e: grep's rc=1 (no match) is a normal answer here

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DIR="${1:-}"
[ -n "$DIR" ] || {
  echo "cred-scan-tree: usage: cred-scan-tree.sh <dir> [--exclude-dir=NAME]..." >&2; exit 2; }
[ -d "$DIR" ] || { echo "cred-scan-tree: not a directory: $DIR" >&2; exit 2; }
shift

# Only --exclude-dir is accepted, and anything else is a usage error rather than an
# argument forwarded to grep. build-mcpb.sh used to carry its own copy of this scan so
# it could exclude node_modules, and that copy is where #108 M1 lived: the duplicate
# never got the rc=2 handling this file has had since #65. One scanner, one caller-
# supplied exclusion, no second implementation to fall behind.
EXCLUDES=()
for arg in "$@"; do
  case "$arg" in
    --exclude-dir=?*) EXCLUDES+=("$arg") ;;
    *) echo "cred-scan-tree: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Fail closed if the shared pattern is missing or empty: an unbound $CRED would
# match nothing and report a clean tree.
PATTERN="$SCRIPT_DIR/cred-pattern.sh"   # shared CRED shape
[ -f "$PATTERN" ] || {
  echo "cred-scan-tree: missing $PATTERN — cannot verify; failing closed" >&2; exit 2; }
source "$PATTERN"
[ -n "${CRED:-}" ] || {
  echo "cred-scan-tree: the CRED pattern is empty — cannot verify; failing closed" >&2; exit 2; }

# `-a` + LC_ALL=C is deliberate: it processes non-UTF8 and binary files as text
# rather than `-I` skipping them, so a token embedded in a binary asset cannot pass
# unseen. `-l` prints names only.
# `${EXCLUDES[@]+...}` because an empty array under `set -u` is an error in bash 3.2,
# which is what macOS ships and what a public contributor may well be running.
HITS="$(LC_ALL=C grep -a -r -l -E --exclude-dir=.git ${EXCLUDES[@]+"${EXCLUDES[@]}"} "$CRED" "$DIR" 2>/dev/null)"
rc=$?

# grep: 0 = matched, 1 = no match, >1 = error. An error means the tree was not
# fully read, which is not the same as clean.
if [ "$rc" -gt 1 ]; then
  echo "cred-scan-tree: grep failed (rc=$rc) over $DIR — cannot verify; failing closed" >&2
  exit 2
fi
if [ -n "$HITS" ]; then
  printf '%s\n' "$HITS"
  exit 1
fi
exit 0
