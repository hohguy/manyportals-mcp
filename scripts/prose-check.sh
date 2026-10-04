#!/usr/bin/env bash
#
# Plain-English check over the PUBLIC doc set (the files publish-sync assembles
# into the public repo). Three deterministic rules, so this either passes or names
# the line to fix, never a warning nobody acts on:
#
#   1. No em dash. Public docs are written for readers whose first language may
#      not be English; full stops, commas and parentheses carry the same meaning
#      with less ambiguity, and heavy em-dash use is the clearest stylistic tell
#      of machine-drafted prose.
#   2. No filler phrases from the list below. Each one was removed from these
#      docs by hand; the list keeps them from coming back.
#   3. ISO 8601 dates. "28 September 2026" and "September 28, 2026" read as different
#      orders to different readers; 2026-09-28 does not.
#
# Untracked-but-not-ignored files are included on purpose (`--others
# --exclude-standard`): a brand-new document is exactly when this check matters, and
# plain `git ls-files` skips it in silence. That was caught by injecting an em dash into
# a new file and watching the check pass.
#
# Internal docs (docs/**, project-docs/**) are deliberately NOT checked: they are
# working notes for one maintainer, not published prose.
set -uo pipefail

cd "$(dirname "$0")/.."

# Two layouts, one rule set. In the DEV repo the public doc set is authored under
# public/; in the ASSEMBLED public repo the same files sit at the root (README.md,
# SECURITY.md, docs/, examples/). publish-sync runs `npm run verify` inside the
# staged repo, so a check that only knew the dev layout would break there — the
# same fault as shipping a CI workflow whose script was never copied (RT-15).
#
# Which one is not GUESSED. `[ -d public ]` made an empty directory of that name flip
# the rule set, and the checks that ship are the ones that must not be switchable by
# accident (#107).
LAYOUT_LIB='scripts/layout.sh'
[ -f "$LAYOUT_LIB" ] || {
  echo "prose-check: missing $LAYOUT_LIB — cannot verify; failing closed" >&2; exit 1; }
source "$LAYOUT_LIB"
LAYOUT="$(mp_layout .)" || exit 1

if [ "$LAYOUT" = dev ]; then
  # Release notes live in project-docs (which never ships) but are PUBLISHED prose:
  # they become the text of a GitHub release. Same rules apply.
  set -- 'public/*.md' 'public/**/*.md' 'project-docs/release-notes-*.md'
else
  # Every document the allowlist ships. CONTRIBUTING.md and the issue templates were
  # missing here, so the rules could not be enforced in the one repo whose CI is
  # meant to enforce them (#68).
  set -- 'README.md' 'SECURITY.md' 'CONTRIBUTING.md' 'CODE_OF_CONDUCT.md' \
         'CHANGELOG.md' 'docs/*.md' 'examples/*.md' '.github/ISSUE_TEMPLATE/*.md'
fi

# Read into an ARRAY over NUL. The list used to be a plain string expanded unquoted,
# so a document whose name contains a space was split into two nonexistent operands,
# grep's error was discarded by `|| true`, and the file went unscanned while the
# check reported clean (#68).
# Read from a FILE, not a process substitution: the producer's exit status is
# invisible through `< <(...)`, so a truncating or failing `git ls-files` left this
# checking a prefix of the doc set and reporting clean over the rest (#109).
# shellcheck source=scripts/enumerate.sh
. "$(dirname "$0")/enumerate.sh"
LIST="$(enum_tempfile)" || exit 1
enum_to "$LIST" git ls-files -z --cached --others --exclude-standard -- "$@" || exit 1

FILES=()
while IFS= read -r -d '' f; do FILES+=("$f"); done < "$LIST"
[ "${#FILES[@]}" -gt 0 ] || { echo "prose-check: no public docs found" >&2; exit 1; }
# Every record that was enumerated must have been read. `-gt 0` cannot tell a complete
# list from a truncated one; this can tell a complete list from a partly-consumed one.
[ "${#FILES[@]}" -eq "$(enum_count "$LIST")" ] || {
  echo "prose-check: read ${#FILES[@]} of $(enum_count "$LIST") enumerated documents — failing closed" >&2
  exit 1; }

fail=0

# scan <grep-flags...> <pattern> — sets HITS to the matching lines, and STOPS the run
# if the documents could not be read.
#
# grep exits 1 for "no match" and above 1 for "I could not look", and `|| true`
# collapsed the second into the first: with the pattern file removed, or one document
# at mode 000, this printed three Permission denied lines and then "clean prose",
# rc=0 (#108).
#
# It sets a GLOBAL rather than printing, because `HITS=$(scan ...)` would run it in a
# subshell where `exit 1` ends only the substitution and the script carries on with
# HITS empty. That is the same defect in a new place.
scan() {
  local rc=0
  HITS="$(grep "$@" "${FILES[@]}")" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "prose-check: cannot read a public document (grep rc=$rc) — failing closed" >&2
    exit 1
  fi
}

# Each pattern must be non-empty. prose-pattern.sh going missing left FILLER and
# DATE_LONGFORM unbound, the subshell died, HITS came back empty, and two of the three
# rules silently stopped existing (#108).
require_pattern() {
  [ -n "${2:-}" ] || {
    echo "prose-check: the $1 pattern is empty or unset — failing closed" >&2; exit 1; }
}

# 1) em dash
scan -nH "—"
if [ -n "$HITS" ]; then
  echo "prose-check: em dash in a public doc (use a full stop, a comma, or parentheses):"
  echo "$HITS" | sed 's/^/  /'
  fail=1
fi

# 2) filler phrases (case-insensitive, whole phrase). FILLER is defined once, in
#    prose-pattern.sh, and shared with publish-sync.sh's commit-message gate.
# shellcheck source=scripts/prose-pattern.sh
PATTERN_LIB="$(dirname "$0")/prose-pattern.sh"
[ -f "$PATTERN_LIB" ] || {
  echo "prose-check: missing $PATTERN_LIB — cannot verify; failing closed" >&2; exit 1; }
. "$PATTERN_LIB"
require_pattern FILLER "${FILLER:-}"
scan -nHiE "$FILLER"
if [ -n "$HITS" ]; then
  echo "prose-check: filler phrase in a public doc (say the thing plainly instead):"
  echo "$HITS" | sed 's/^/  /'
  fail=1
fi

# 2b) claims the code does not support (see OVERCLAIM in prose-pattern.sh)
require_pattern OVERCLAIM "${OVERCLAIM:-}"
scan -nHiE "$OVERCLAIM"
if [ -n "$HITS" ]; then
  echo "prose-check: a public doc claims this of every ACTION; routing is enforced for"
  echo "             writes, and reads may use the selected default. Say 'write':"
  echo "$HITS" | sed 's/^/  /'
  fail=1
fi

# 3) long-form dates
require_pattern DATE_LONGFORM "${DATE_LONGFORM:-}"
scan -nHiE "$DATE_LONGFORM"
if [ -n "$HITS" ]; then
  echo "prose-check: long-form date in a public doc (use ISO 8601, as in 2026-09-28):"
  echo "$HITS" | sed 's/^/  /'
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "prose-check: FAILED" >&2
  exit 1
fi
echo "prose-check: clean, public docs carry no em dash, no filler phrase, no unsupported claim and no long-form date"
