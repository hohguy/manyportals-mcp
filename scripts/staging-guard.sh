#!/usr/bin/env bash
#
# staging-guard.sh — nothing is removed unless this tool created it (#104).
#
# WHY THIS SHAPE. #62 was `--out /Users` becoming `//Users` through path arithmetic
# and slipping an ancestor guard that compared strings, one step from `rm -rf` on a
# path holding every user account. out-guard.sh now refuses that shape. But a
# deny-list over string shapes has to enumerate every hazardous shape, and #62 was
# exactly a shape nobody enumerated: the next unlisted one behaves the same way.
#
# So this asks a different question. Instead of "is this path dangerous", it asks
# "did I create it". A directory is removable only while it carries a marker file
# this tool wrote. `/Users` carries no marker, so it is refused REGARDLESS of any bug
# in the code that computed the path, because the check never inspects the string.
#
# One invariant, where the deny-list is unbounded. It is also the shape the rest of
# this codebase already uses: allowedObjects, allowedOperations, the publish
# allowlist and the egress allowlist are all default-deny. Use BOTH this and
# out-guard.sh; they fail in different ways.
#
# Deliberately NOT relied on: an operator confirmation. This project already holds
# that a click is weak evidence, which is why apply mode still runs the whole write
# lifecycle and why the approval phrase is a phrase.
#
STAGING_MARKER='.manyportals-staging'
# Line 1 of a marker this tool wrote. An EMPTY file of the right name, and any file
# that happens to carry that name, both fail this (#106).
STAGING_MAGIC='ManyPortals staging directory (marker v1).'

# staging_claim <dir> — create <dir> and mark it as removable by this tool.
staging_claim() {
  local dir="${1:-}" resolved
  [ -n "$dir" ] || { echo "FATAL: staging_claim needs a directory" >&2; return 1; }
  mkdir -p "$dir"
  # Line 2 is the directory this marker was written FOR. Presence alone said only
  # "a file with this name is here", which a copy, a hard link and a symlink all
  # satisfy for a directory nobody claimed. Recording the path means a marker that
  # travelled carries the ORIGINAL path and authorises nothing (#106).
  resolved="$(cd "$dir" && pwd -P)" || {
    echo "FATAL: staging_claim cannot resolve $dir" >&2; return 1; }
  # Written IMMEDIATELY after mkdir: a crash between the two leaves an unmarked
  # directory, which the next run refuses rather than silently wipes. That is the
  # correct direction to fail.
  {
    echo "$STAGING_MAGIC"
    echo "$resolved"
    echo "Created $(date -u +%Y-%m-%dT%H:%M:%SZ) by a ManyPortals script."
    echo
    echo "This file is what permits the tool to remove this directory again."
    echo "The second line is the directory it was written for. Copying, linking or"
    echo "moving this file does not carry that permission with it."
  } > "$dir/$STAGING_MARKER"
}

# staging_marker_ok <dir> — does <dir> carry a marker this tool wrote FOR <dir>?
#
# What presence could not establish, each verified against a fixture: `-f` FOLLOWS a
# symlink, so a marker symlinked to a real one passed; an empty file of that name
# passed; and a hard-linked or hand-copied marker passed, so an unrelated directory
# carrying any of them was deleted (#106). Origin is established by the recorded
# path, which a copy cannot update for its new home.
#
# NOT established, and deliberately so: this cannot tell a marker THIS tool wrote
# from one a person wrote by hand with the right two lines. That is not the threat.
# Someone able to write that file is able to run `rm -rf` themselves; the guard exists
# to stop an unmarked or accidentally-marked directory being removed by a bug in the
# code that computed the path.
#
# RESIDUAL, accepted: the window between this check and the `rm` that follows it. A
# deliberate swap of the directory at that pathname is not detected, and closing it
# needs file-descriptor-relative removal that POSIX shell does not offer. It was
# demonstrated only by scheduling the swap with a debug trap; no probabilistic or
# cross-user exploit is claimed. Documented rather than fixed, because the fix is a
# rewrite out of shell and the exposure is a local operator racing their own tool.
staging_marker_ok() {
  local dir="${1:-}" marker resolved magic='' recorded=''
  [ -n "$dir" ] || return 1
  marker="$dir/$STAGING_MARKER"
  if [ -L "$marker" ]; then
    echo "FATAL: the marker in this directory is a symlink, so it describes some" >&2
    echo "       other directory. Refusing." >&2
    return 1
  fi
  [ -f "$marker" ] || return 1
  # `read` returns non-zero at EOF, which an empty marker hits immediately; the
  # variables stay empty and the comparisons below refuse.
  { IFS= read -r magic || true; IFS= read -r recorded || true; } < "$marker"  # idiom-ok: EOF is expected; empty values are refused below
  if [ "$magic" != "$STAGING_MAGIC" ]; then
    echo "FATAL: the marker in this directory was not written by this tool." >&2
    echo "       If it came from a version before the marker recorded its own" >&2
    echo "       path, remove the directory yourself once and let the tool" >&2
    echo "       recreate it." >&2
    return 1
  fi
  resolved="$(cd "$dir" && pwd -P)" || return 1
  if [ "$recorded" != "$resolved" ]; then
    echo "FATAL: the marker here was written for a different directory:" >&2
    echo "       the marker says: $recorded" >&2
    echo "       this directory is: $resolved" >&2
    echo "       A marker that was copied, linked or moved carries the original" >&2
    echo "       path with it and does not authorise removing this one." >&2
    return 1
  fi
  return 0
}

# staging_wipe <dir> [label] — remove <dir>, but only if this tool created it.
# A path that does not exist is not an error: there is nothing to remove.
staging_wipe() {
  local dir="${1:-}" what="${2:-staging directory}"
  [ -n "$dir" ] || { echo "FATAL: staging_wipe called with an empty path" >&2; return 1; }
  # A symlink: `rm -rf` would remove the link rather than the target, but the marker
  # test below would FOLLOW it, so a link pointing at a marked directory would
  # authorise removing a different path than the one checked. Refuse instead of
  # reasoning about it.
  if [ -L "$dir" ]; then
    echo "FATAL: refusing to remove the $what: it is a symlink" >&2
    echo "       $dir" >&2
    return 1
  fi
  [ -e "$dir" ] || return 0
  if [ ! -d "$dir" ]; then
    echo "FATAL: refusing to remove the $what: it is not a directory" >&2
    echo "       $dir" >&2
    return 1
  fi
  if ! staging_marker_ok "$dir"; then
    echo "FATAL: refusing to remove the $what, because this tool did not create it." >&2
    echo "       $dir" >&2
    echo "       A directory is removed here only while it carries a marker file" >&2
    echo "       $STAGING_MARKER naming that same directory, written when this tool" >&2
    echo "       created it. If you meant to reuse that path, remove it yourself first." >&2
    return 1
  fi
  rm -rf "$dir"
}

# staging_wipe_file <file> <required-parent> — remove a FILE this tool produces,
# only when it sits directly inside the directory it is supposed to. Used for build
# artifacts, which are named rather than marked.
staging_wipe_file() {
  local file="${1:-}" parent="${2:-}"
  [ -n "$file" ] && [ -n "$parent" ] || {
    echo "FATAL: staging_wipe_file needs a file and its expected parent" >&2; return 1; }
  [ -e "$file" ] || return 0
  if [ -d "$file" ]; then
    echo "FATAL: refusing to remove $file as a file: it is a directory" >&2; return 1
  fi
  local actual
  actual="$(cd "$(dirname "$file")" && pwd -P)" || return 1
  local expected
  expected="$(cd "$parent" && pwd -P)" || return 1
  if [ "$actual" != "$expected" ]; then
    echo "FATAL: refusing to remove $file: it is not inside $expected" >&2
    return 1
  fi
  rm -f "$file"
}
