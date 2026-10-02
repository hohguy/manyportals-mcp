#!/usr/bin/env bash
#
# enumerate.sh — run a producer, and stop if it did not finish (#109).
#
# `while IFS= read -r -d '' f; do ... done < <(producer)` is the standard shell idiom
# for walking a NUL-separated list, and it has one property that makes it unusable in
# a gate: the producer runs in a process substitution, whose exit status the shell
# never reports and `set -e` cannot observe. A `git ls-files` that dies partway, or a
# `find` that meets an unreadable directory, leaves the loop having examined a PREFIX
# of the set while every check inside it passed. The loop cannot tell the difference
# between "I looked at everything and it was fine" and "I looked at some of it".
#
# Measured, not theorised. A shim emitting 6 of 52 records then exiting 1 produced
# "Assembled 49 files", a clean audit, and a Source-Commit trailer naming a commit
# that holds 52 source files. A 0777 file under a 0700 directory produced a
# "Permission denied" line from find followed by "every file carries its expected
# mode", rc 0, with the violation still sitting there.
#
# The fix is to stop reading from a process substitution. Put the producer's output in
# a file, where its exit status is observable, and read the loop from that.
#
#   TMP="$(enum_tempfile)" || exit 1
#   enum_to "$TMP" git ls-files -z -- src || exit 1
#   while IFS= read -r -d '' f; do ...; done < "$TMP"
#
# NOTE: this installs an EXIT trap to remove the temp files. No script in this repo
# sets one, and a caller that needs its own must chain to _enum_cleanup.

ENUM_TEMPFILES=()

_enum_cleanup() {
  if [ "${#ENUM_TEMPFILES[@]}" -gt 0 ]; then rm -f "${ENUM_TEMPFILES[@]}"; fi
  return 0
}
trap _enum_cleanup EXIT

# enum_tempfile — prints the path of a temp file, which `enum_to` registers for removal
# when this shell exits.
#
# The append below is NOT what makes that happen, and the comment here used to say it
# was. Callers invoke this in a command SUBSTITUTION — `TMP="$(enum_tempfile)"` — so the
# append runs in a subshell and never reaches the parent array the EXIT trap reads. The
# file survived, and roughly ten thousand of them accumulated in one working session,
# because the register runs the whole suite once per mutation (#128). It is kept because
# it is correct for a caller in parent context and harmless in a subshell; `enum_to` is
# the half that fires for every real caller.
enum_tempfile() {
  local t
  t="$(mktemp "${TMPDIR:-/tmp}/mp-enum.XXXXXX")" || {
    echo "FATAL: cannot create a temporary file for the enumeration" >&2; return 1; }
  ENUM_TEMPFILES+=("$t")
  printf '%s' "$t"
}

# enum_to <file> <command...> — run the producer into <file>, or fail closed.
enum_to() {
  [ "$#" -ge 2 ] || {
    echo "FATAL: enum_to needs an output file and a command" >&2; return 1; }
  local dest="$1"
  # Registered BEFORE the producer runs, not after. enum_to returns 1 when the
  # enumeration did not complete and every caller exits on that, so registering
  # afterwards would leak precisely the file holding the partial list.
  ENUM_TEMPFILES+=("$dest")
  shift
  local rc=0
  "$@" > "$dest" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FATAL: the enumeration did not complete (rc=$rc): $*" >&2
    echo "       Refusing to report on a partial list. Every check would pass over" >&2
    echo "       the entries it managed to read and say nothing at all about the" >&2
    echo "       rest, which reads exactly like success." >&2
    return 1
  fi
  return 0
}

# enum_count <file> — how many NUL-separated records <file> holds.
# Used where a run needs to assert it examined the whole set rather than a non-empty
# part of it: `-gt 0` cannot tell complete from truncated.
enum_count() {
  tr -dc '\0' < "${1:-}" | wc -c | tr -d ' '
}
