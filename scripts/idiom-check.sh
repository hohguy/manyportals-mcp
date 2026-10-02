#!/usr/bin/env bash
#
# idiom-check.sh — the textual patterns behind the 2026-09-28 review classes (#113).
#
# WHY THIS EXISTS. Every fix in that review landed as an edit to the one file that was
# burned. Codex and three independent verification agents each reached that diagnosis
# alone, and this project's own engineering-lessons L1 had stated it in July: "a local
# fix to a general anti-pattern is a half-fix." The lesson was written down and changed
# nothing, because nothing enforced it.
#
# So the idioms are enumerated here instead of remembered. A rule catches every present
# holder AND every future one, which is what a per-file fix cannot do.
#
# DEFAULT-DENY, like the rest of this codebase. A match is a failure unless the line
# carries `idiom-ok: <reason>`. Every exemption is therefore a claim on the line itself,
# where the next reader sees it, rather than a list somewhere else that drifts.
#
# WHAT IT DOES NOT COVER, so the gap is on the record rather than implied:
#   - Semantic TypeScript shapes (an `existsSync` precondition hiding an access error,
#     an empty catch). They are not reliably textual; they belong to #111.
#   - `stat -f` probed before `stat -c`. That is an ORDERING defect within a file, not
#     a line, and grep cannot express it. perm-check.sh carries a registered mutation
#     for it instead.
#   - Whether an enumeration has a completeness postcondition (#109). The loop and the
#     assertion are different lines and the link between them is not textual.
# A rule that cannot be written honestly is left out and named here.
set -uo pipefail

cd "$(dirname "$0")/.."

# NUL-safe enumeration with an observable producer status. Shared, not reimplemented: a
# second walker would be the shape of #108, where build-mcpb kept its own copy of a scan
# and never received the fix its sibling had.
# shellcheck source=scripts/enumerate.sh
. "$(dirname "$0")/enumerate.sh"

# The rule table. Held in PARALLEL ARRAYS rather than packed into delimited strings:
# the first version packed them with `|`, every regex here contains `|`, and three
# rules were silently truncated to a fragment that matched nothing. They reported
# clean over eighteen real hits. A rule table that cannot express its own regexes is
# a check that cannot fire, which is the class this file exists to catch, so the
# structure is now one that has no delimiter to collide with.
#
# Keep `why` short: it prints beside the offending line and is the whole reason
# someone will fix it rather than reach for an exemption.
RULE_IDS=() RULE_GLOBS=() RULE_ERES=() RULE_WHYS=()
rule() {
  RULE_IDS+=("$1"); RULE_GLOBS+=("$2"); RULE_ERES+=("$3"); RULE_WHYS+=("$4")
}

rule swallowed-status 'scripts/*.sh scripts/*.mjs' \
  '\|\| true' \
  'the status is discarded, so "could not look" reads as "nothing found" (#108)'

rule silenced-condition 'scripts/*.sh' \
  '^[[:space:]]*(if|elif|while|until)[[:space:]].*2>[[:space:]]*(/dev/null|&1)' \
  'grep exits 2 when it cannot read, and 2 is falsy, so the gate branch is skipped (#108)'

rule grep-q-piped 'scripts/*.sh' \
  '\|[^|]*grep[^|]*[[:space:]]-[a-zA-Z]*q' \
  'grep -q exits early, the producer takes SIGPIPE, and pipefail reports 141 (#105)'

rule grep-skips-binary 'scripts/*.sh' \
  'grep[[:space:]]+(-[a-zA-Z-]+[[:space:]]+)*-[a-zA-Z]*I' \
  '-I skips binary files, so a secret inside one is never scanned (#110)'

rule head-in-gate-pipeline 'scripts/*.sh' \
  '\|[[:space:]]*head[[:space:]]' \
  'head exits early and SIGPIPEs its producer; use sed -n to print a prefix'

rule layout-sniff 'scripts/*.sh scripts/*.mjs' \
  '\[[[:space:]]+-d[[:space:]]+public[[:space:]]+\]|existsSync\((.)public\1\)' \
  'an empty directory named public must not decide which files are scanned (#107)'

# DIAG is the set of files whose job is to tell an operator what is true. A wrong
# answer there is not a crash, it is a confident lie: "status: healthy" over a
# mode-0666 vault, "the token is revoked" while the env var still serves the portal,
# "ALL PORTALS PASSED" after a 403 (#111).
DIAG='src/index.ts src/doctor/index.ts src/preflight/index.ts'

rule existsSync-in-a-diagnostic "$DIAG" \
  'existsSync\(' \
  'existsSync is false for "absent" AND for "could not look"; stat and read the errno (#111)'

rule unbound-catch-in-a-diagnostic "$DIAG" \
  'catch[[:space:]]*\{' \
  'a catch that does not bind the error cannot tell ENOENT from anything else (#111)'

# The guard grammar must stay ENFORCEABLE. guard-register.mjs inventories refusal sites by
# recognising specific forms, and it cannot see `exit $rc`, so a refusal written that way
# escapes the count silently. The claim it supports is "all refusal sites expressed in the
# enforced grammar are accounted for", and that claim is only worth something if the
# grammar is the only way to refuse (#124).
rule refusal-outside-the-grammar 'scripts/*.sh' \
  'exit[[:space:]]+"?\$' \
  'the refusal inventory cannot see a non-literal exit status; use a literal, or set a flag (#124)'

rule rc-null-conflated 'src/*.ts src/**/*.ts' \
  'status \?\? 1' \
  'execFileSync sets status null on signal death, so a killed child reads as "the guard fired" (#113)'

fail=0
checked=0

# A guard whose input list is empty passes vacuously. That is the defect this whole
# file exists to catch, so it must not be available to this file.
[ "${#RULE_IDS[@]}" -gt 0 ] || {
  echo "idiom-check: the rule table is empty, which is not a pass" >&2; exit 1; }

for i in "${!RULE_IDS[@]}"; do
  id="${RULE_IDS[$i]}"
  globs="${RULE_GLOBS[$i]}"
  ere="${RULE_ERES[$i]}"
  why="${RULE_WHYS[$i]}"

  # Enumerate through git so untracked-but-not-ignored files are included: a brand-new
  # script is exactly when this matters, and a plain glob would miss a deleted-but-
  # still-globbed path.
  #
  # NUL-separated, through a FILE. Without `-z`, git QUOTES a filename containing a
  # newline or a control character, and the quoted form is not a path, so `[ -f ]` was
  # false and the file was skipped in silence (#126). A bash variable cannot hold a NUL
  # byte, so the list cannot be captured with `$(...)`; enum_to streams it and makes the
  # producer's exit status observable at the same time (#109).
  files="$(enum_tempfile)" || exit 1
  # shellcheck disable=SC2086
  enum_to "$files" git ls-files -z --cached --others --exclude-standard -- $globs || exit 1
  [ "$(enum_count "$files")" -gt 0 ] || {
    echo "idiom-check: rule $id matched no files at all; its globs are stale" >&2
    fail=1; continue; }

  hits=""
  while IFS= read -r -d '' f; do
    [ -n "$f" ] || continue
    if [ ! -f "$f" ]; then
      # A path git listed that is not a regular file: a directory, a dangling symlink, or
      # a deleted-but-staged entry. Skipping was the old behaviour and it also swallowed
      # the quoted-filename case above, so say which it was rather than going quiet.
      [ -e "$f" ] || [ -L "$f" ] || continue
      echo "idiom-check: $f is listed but not a regular file; not scanned" >&2
      fail=1
      continue
    fi
    checked=$((checked + 1))
    # The SCAN and the FILTERS are separate statements, because a pipeline's status is
    # its LAST command's. `grep -nE ... | grep -v ... | grep -v ...` reported the final
    # filter's status, so a permission error from the scan (rc=2) was masked and an
    # unreadable file passed as clean. That is the defect this very file's
    # `swallowed-status` rule describes (#126).
    raw=""
    grc=0
    raw="$(grep -nE "$ere" -- "$f")" || grc=$?
    if [ "$grc" -gt 1 ]; then
      echo "idiom-check: cannot scan $f for $id (grep rc=$grc), failing closed" >&2
      exit 1
    fi
    out=""
    if [ -n "$raw" ]; then
      # Strip comment lines FIRST: this file and its peers discuss these idioms by name,
      # and a document that describes a convention must not trip the check enforcing it.
      # Then strip lines carrying an explicit, reasoned exemption. These filters' own
      # status is not a gate: rc=1 means everything was filtered out, which is the good
      # case.
      out="$(printf '%s\n' "$raw" \
        | grep -vE '^[0-9]+:[[:space:]]*(#|//|\*|/\*)' \
        | grep -v 'idiom-ok:')" || true  # idiom-ok: filters; the scan's status was captured above
    fi
    [ -n "$out" ] && hits="$hits$(printf '%s\n' "$out" | sed "s#^#  $f:#")"$'\n'
  done < "$files"

  if [ -n "$hits" ]; then
    fail=1
    echo "idiom-check: $id"
    echo "  $why"
    printf '%s' "$hits" | sed -n '1,40p'
    echo "  Fix it, or add \`idiom-ok: <reason>\` to the line if it is genuinely safe."
    echo
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "idiom-check: FAILED" >&2
  exit 1
fi
echo "idiom-check: clean — no known-bad idiom in $checked scanned file(s)"
