#!/usr/bin/env bash
#
# perm-check.sh — refuse to ship a tree whose file modes have drifted.
#
# WHY THIS EXISTS: this repo lives on a synced volume that rewrites file modes at
# any time (104 of 141 tracked files were found at 0700). `cp` in publish-sync.sh
# propagates whatever mode it finds, and the staged repo's fresh `git add` records
# the exec bit, so drift on this machine becomes an executable source tree in the
# PUBLIC repo and owner-only files in the npm tarball. `core.filemode` is false
# here, so `git status` cannot see any of it (#67).
#
# USAGE:
#   bash scripts/perm-check.sh [--fix] [--tree <dir>]
#     (no args)      check this repo: the git index modes AND the working-tree
#                    modes of every tracked file. Exits 1 on any violation.
#     --fix          normalize working-tree modes in place, then re-check. Never
#                    touches the git index; it prints the command for that.
#     --tree <dir>   check every file under <dir> instead (no git). Used on the
#                    assembled public tree, where the modes actually ship.
#
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/enumerate.sh"  # a partial list is not a clean tree (#109)

FIX=0
TREE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fix) FIX=1; shift ;;
    --tree) TREE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Files that are SUPPOSED to carry the exec bit. Everything else is data.
is_exec_expected() {
  case "$1" in
    scripts/build-mcpb.sh) return 0 ;;
    *) return 1 ;;
  esac
}

# Pick the stat dialect ONCE, and probe GNU FIRST. Order is the whole point: GNU's
# `stat -f` means "file system status", not a format string, so the BSD-first probe
# SUCCEEDED on Linux, returned a multi-line filesystem block, and every file compared
# unequal to its expected mode. 149 violations on a clean checkout, and the `||`
# fallback never ran because nothing had failed (CI, 2026-09-28). GNU's failure on
# BSD, by contrast, is unambiguous.
if stat -c '%a' . >/dev/null 2>&1; then  # idiom-ok: a dialect probe; failure is the answer it is looking for
  _stat_mode() { stat -c '%a' "$1" 2>/dev/null; }
elif stat -f '%OLp' . >/dev/null 2>&1; then  # idiom-ok: same probe, BSD dialect
  _stat_mode() { stat -f '%OLp' "$1" 2>/dev/null; }
else
  echo "perm-check: no usable stat(1) — failing closed" >&2
  exit 1
fi

mode_of() {
  local m
  m="$(_stat_mode "$1")"
  # Validate the SHAPE, not merely that something came back. A wrong dialect returns
  # prose, which is never equal to "644" and so reads as a violation on every file
  # rather than as the configuration error it actually is.
  case "$m" in
    [0-7][0-7][0-7]) printf '%s' "$m" ;;
    [0-7][0-7][0-7][0-7]) printf '%s' "${m#?}" ;;   # drop setuid/sticky digit
    *)
      echo "perm-check: stat did not return a mode for $1 — failing closed" >&2
      exit 1
      ;;
  esac
}

violations=0
fixed=0

check_file() { # check_file <path-to-stat> <name-for-policy-and-messages>
  local path="$1" name="$2" want mode
  if is_exec_expected "$name"; then want=755; else want=644; fi
  mode="$(mode_of "$path")"
  [ "$mode" = "$want" ] || {
    if [ "$FIX" -eq 1 ]; then
      chmod "0$want" "$path"
      fixed=$((fixed+1))
    else
      printf '  %-6s %-5s (want %s)  %s\n' "MODE" "$mode" "$want" "$name"
      violations=$((violations+1))
    fi
  }
}

# POSIX permission bits do not exist on Windows; a Git Bash checkout reports whatever
# the filesystem mapping invents, so a working-tree mode check there tests nothing and
# would fail the Windows CI leg on a property that has no meaning. The GIT INDEX modes
# are portable, because git stores them, and the index is where the real defect was
# found (README.md committed 100755), so that half always runs.
POSIX_MODES=1
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) POSIX_MODES=0 ;;
esac

run_checks() {
  violations=0
  if [ -n "$TREE" ]; then
    echo "==> checking file modes under $TREE"
    [ -d "$TREE" ] || { echo "perm-check: no such directory: $TREE" >&2; exit 1; }
    if [ "$POSIX_MODES" -eq 0 ]; then
      echo "    (skipped: $(uname -s) has no POSIX permission bits)"
      return 0
    fi
    # find exits non-zero when it could not read part of the tree. Read through a
    # process substitution that status was invisible, so an unreadable subdirectory
    # produced "every file carries its expected mode" over the files it did reach.
    local tmp
    tmp="$(enum_tempfile)" || exit 1
    enum_to "$tmp" find "$TREE" -path "$TREE/.git" -prune -o -type f -print0 || exit 1
    while IFS= read -r -d '' f; do
      check_file "$f" "${f#"$TREE"/}"
    done < "$tmp"
    return 0
  fi

  if [ "$POSIX_MODES" -eq 1 ]; then
    echo "==> checking working-tree modes of tracked files"
    # Run from a non-git directory this printed "fatal: not a git repository", examined
    # ZERO files, and then asserted that every file carries its expected mode (#109).
    local tmp
    tmp="$(enum_tempfile)" || exit 1
    enum_to "$tmp" git ls-files -z || exit 1
    while IFS= read -r -d '' f; do
      [ -f "$f" ] || continue   # a deleted-but-tracked path is git's problem, not ours
      check_file "$f" "$f"
    done < "$tmp"
  else
    # Said out loud, not skipped quietly: a check that goes silent is one nobody
    # notices has stopped running.
    echo "==> skipping working-tree modes: $(uname -s) has no POSIX permission bits"
  fi

  # The index is a SEPARATE surface: core.filemode=false means a wrong mode here
  # survives every working-tree fix and every `git status`, and it is the mode the
  # public repo inherits. --fix cannot repair it silently; print the command.
  echo "==> checking git index modes"
  local meta name mode want itmp
  itmp="$(enum_tempfile)" || exit 1
  enum_to "$itmp" git ls-files -s || exit 1
  while IFS=$'\t' read -r meta name; do
    mode="${meta%% *}"
    if is_exec_expected "$name"; then want=100755; else want=100644; fi
    [ "$mode" = "$want" ] || {
      printf '  %-6s %s (want %s)  %s\n' "INDEX" "$mode" "$want" "$name"
      echo "         fix: git update-index --chmod=$([ "$want" = 100755 ] && echo +x || echo -x) -- '$name'"
      violations=$((violations+1))
    }
  done < "$itmp"
}

run_checks
if [ "$FIX" -eq 1 ] && [ "$fixed" -gt 0 ]; then
  echo "perm-check: normalized $fixed working-tree file(s); re-checking"
  FIX=0          # the second pass must report, not silently repair again
  run_checks
fi

if [ "$violations" -ne 0 ]; then
  echo "perm-check: FAIL — $violations mode violation(s)." >&2
  echo "  Working tree: bash scripts/perm-check.sh --fix. Index fixes are printed above." >&2
  exit 1
fi
echo "perm-check: clean — every file carries its expected mode"
