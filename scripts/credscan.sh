#!/usr/bin/env bash
#
# credscan.sh — fast local+CI mirror of publish-sync.sh's HARD credential scan.
#
# WHY: the publish-sync.sh audit (gate B) is the authority on "no credential ships
#   to the public repo", but it only runs at publish time. A change to src/ can
#   therefore break it and land green — which happened once: RT-10a (c9f3300) added
#   a credential-SHAPED negative-test fixture and the publish audit silently
#   hard-failed on the real repo until an end-to-end run caught it. This check runs
#   in `npm run verify` AND CI so that class cannot recur unseen.
#
# WHAT: fail if a CONTIGUOUS credential-shaped literal (HubSpot PAT or PEM private
#   key) exists in a surface that gets published. A legitimately credential-SHAPED
#   TEST fixture must be assembled from parts (see src/config/config.test.ts) so it
#   never appears as a contiguous literal here — real leaks are pasted contiguously.
#
# Scope = the credential-bearing surfaces the publish allowlist ships (src wholesale
#   + public docs + the example configs + package/manifest). project-docs/ is NOT
#   scanned: it is private, never shipped, and legitimately discusses token shapes.
#
# NOTE: the CRED pattern comes from the shared scripts/cred-pattern.sh (also sourced
#   by publish-sync.sh). A behaviourally-identical TS mirror is src/config/index.ts
#   `CREDENTIAL_SHAPE`; the config parity test asserts they agree. If HubSpot's token
#   format changes, update cred-pattern.sh and CREDENTIAL_SHAPE (two places, not three).
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

# Fail closed if the shared pattern is missing or empty. Without this, deleting or
# renaming cred-pattern.sh makes `$CRED` unbound, the scan match nothing, and this
# gate print "clean" while a real literal sits in the tree — a guard whose absence
# reads as a pass.
PATTERN="$ROOT/scripts/cred-pattern.sh"   # shared CRED shape (also used by cred-scan-tree.sh)
[ -f "$PATTERN" ] || {
  echo "credscan: missing $PATTERN — cannot verify; failing closed" >&2; exit 1; }
source "$PATTERN"
[ -n "${CRED:-}" ] || {
  echo "credscan: the CRED pattern is empty — cannot verify; failing closed" >&2; exit 1; }

LAYOUT_LIB="$ROOT/scripts/layout.sh"      # shared tree-layout declaration (#107)
[ -f "$LAYOUT_LIB" ] || {
  echo "credscan: missing $LAYOUT_LIB — cannot verify; failing closed" >&2; exit 1; }
source "$LAYOUT_LIB"
LAYOUT="$(mp_layout "$ROOT")" || exit 1

# Scope depends on the LAYOUT. This script SHIPS, and in the assembled public repo
# `public/` does not exist and the example configs were remapped to examples/, so a
# fixed pathspec naming them silently scanned almost nothing — README, SECURITY,
# CONTRIBUTING, docs/*.md and all of examples/ went unchecked, and those are most of
# what npm ships (#64).
#
# The layout used to be inferred from `[ -d public ]`. Creating an empty directory of
# that name in the public repo — an ordinary thing to do — switched this scan to the
# DEV pathspec, which excludes docs/*.md, and the run then printed "clean" with the
# credential still sitting there. The tree now DECLARES which one it is and mp_layout
# refuses to guess (#107).
if [ "$LAYOUT" = dev ]; then
  # Dev repo: everything tracked EXCEPT the two surfaces that legitimately discuss
  # token shapes. The example configs under docs/ are still scanned; only prose is
  # excluded.
  set -- ':(exclude)project-docs' ':(exclude)docs/*.md'
else
  # Public repo: everything tracked is shipped, so scan all of it.
  set -- .
fi
# `-l` prints FILE names, never the matched line, so a real secret is never echoed
# to a log. `--text` rather than `-I`: a token inside a binary must not be skipped,
# which is the same reason cred-scan-tree.sh uses `grep -a` (#64).
# `--untracked` includes untracked-but-not-ignored files. Without it `git grep` sees
# only TRACKED files, so a brand-new file carrying a credential passed this check and
# failed later at the publish gate instead — which is exactly what happened to a new
# test fixture in this repo. A new file is when the check matters most, and it is the
# same reason prose-check.sh passes `--others`.
HITS="$(git grep -l --text --untracked -E "$CRED" -- "$@" 2>/dev/null)"
rc=$?
if [ "$rc" -gt 1 ]; then
  echo "credscan: git grep failed (rc=$rc) — cannot verify; failing closed" >&2
  exit 1
fi
if [ -n "$HITS" ]; then
  echo "credscan: FAIL — contiguous credential-shaped literal in a shipped surface:" >&2
  printf '%s\n' "$HITS" | sed 's/^/  /' >&2
  echo "  A credential-SHAPED test fixture must be assembled from parts" >&2
  echo "  (see src/config/config.test.ts); a real secret must never be committed." >&2
  exit 1
fi
echo "credscan: clean — no contiguous credential-shaped literal in shipped surfaces"
