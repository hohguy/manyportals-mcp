#!/usr/bin/env bash
#
# out-guard.sh — normalize and vet the staging path that publish-sync.sh WIPES.
#
# Sourced by publish-sync.sh. Deliberately PURE: this file contains no `rm`, no
# `cp` and no `git`, so the test suite can drive the guard against the dangerous
# inputs (an ancestor of the repo, an ancestor of HOME, `/`) without any run
# being able to delete anything. A guard whose only test would be catastrophic
# is a guard nobody tests.
#
# out_normalize <raw>                       → canonical absolute path on stdout
# out_assert_safe <path> <dev-root> <home>  → rc 0 if safe to wipe, else rc 1

# Collapse repeated and trailing slashes. Used twice on purpose; see below.
_out_collapse() { printf '%s' "$1" | sed -E 's#/+#/#g; s#/$##'; }

out_normalize() {
  local raw="$1" collapsed parent
  # Absolute only: a relative `--out src` would wipe `src` relative to cwd.
  case "$raw" in
    /*) : ;;
    *) echo "FATAL: --out must be an absolute path (got: $raw)" >&2; return 1 ;;
  esac
  collapsed="$(_out_collapse "$raw")"
  # Reject root/empty BEFORE canonicalizing: `dirname ""` is `.`, which would
  # resolve the path against the current directory.
  [ -n "$collapsed" ] || {
    echo "FATAL: refusing unsafe --out (path resolves to root/empty)" >&2; return 1; }
  parent="$(dirname "$collapsed")"
  # Canonicalize PHYSICALLY so a symlinked parent cannot traverse into the repo
  # and so the guards compare like-for-like with a `pwd -P` dev root. The parent
  # must exist; the leaf is the directory we create.
  [ -d "$parent" ] || {
    echo "FATAL: --out parent directory does not exist: $parent" >&2; return 1; }
  # Canonicalize the LEAF as well. `basename` re-attached it verbatim, so `$HOME/.`
  # normalized to `$HOME/.` and `$HOME/..` to `$HOME/..`. out_assert_safe then
  # compared those strings against HOME and against the ancestor patterns, matched
  # neither, and ACCEPTED paths denoting HOME and the directory above it (#106).
  # Interior `..` was never the problem: `cd "$parent" && pwd -P` resolves those.
  #
  # Collapse AGAIN after reassembly. `cd / && pwd -P` prints `/`, so a depth-1
  # path came back as `//Users`, and `case "$DEV_ROOT/" in "//Users"/*)` cannot
  # match — the ancestor guard was bypassed for exactly the paths it exists to
  # refuse (#62).
  case "$(basename "$collapsed")" in
    .|..)
      # A `.` or `..` leaf names an EXISTING directory (the parent was checked just
      # above), so resolve the whole path instead of pinning a canonical parent to a
      # component whose meaning is "somewhere else".
      _out_collapse "$(cd "$collapsed" && pwd -P)" ;;
    *)
      _out_collapse "$(cd "$parent" && pwd -P)/$(basename "$collapsed")" ;;
  esac
}

out_assert_safe() {
  local out="$1" devroot="$2" home="$3"
  case "$out" in
    ''|/) echo "FATAL: refusing unsafe --out ($out)" >&2; return 1 ;;
    # Normalization is what the guards below depend on. If a path reaches here
    # still holding a doubled slash, the pattern matches will not mean what they
    # appear to mean, so refuse rather than compare.
    *//*) echo "FATAL: refusing unsafe --out (path is not normalized: $out)" >&2; return 1 ;;
  esac
  [ "$out" != "$home" ] || {
    echo "FATAL: refusing unsafe --out (it is HOME: $out)" >&2; return 1; }
  case "$out" in
    "$devroot"|"$devroot"/*)
      echo "FATAL: --out must be OUTSIDE the dev repo (got: $out)" >&2; return 1 ;;
  esac
  case "$devroot/" in
    "$out"/*) echo "FATAL: --out is an ANCESTOR of the dev repo — refusing (got: $out)" >&2; return 1 ;;
  esac
  # HOME need not be inside the dev repo (and the repo may live outside HOME), so
  # an ancestor of HOME is its own case: `--out /Users` wipes every account.
  case "$home/" in
    "$out"/*) echo "FATAL: --out is an ANCESTOR of HOME — refusing (got: $out)" >&2; return 1 ;;
  esac
  return 0
}
