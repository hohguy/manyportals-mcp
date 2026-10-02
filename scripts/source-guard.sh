#!/usr/bin/env bash
#
# source-guard.sh — is this file the exact one the publish allowlist named? (#106)
#
# Sourced by publish-sync.sh. PURE by design, like out-guard.sh: no `cp`, no `rm`,
# no `git`. The assembler's copy step is the one place where being wrong publishes a
# private document, so the decision has to be testable on its own, against the inputs
# that matter, without any run being able to copy anything.
#
# The defect it replaces: the copy step refused a symlinked LEAF and then required the
# resolved PARENT to sit somewhere under the dev root. The private tree is under the
# dev root too. A committed `public/examples -> ../project-docs/PORTAL_A` resolved
# inside the repo, passed both tests, and published a private document as
# examples/README.md. The audit that runs afterwards is a blocklist of private NAMES,
# and the file had arrived under an allowlisted name, so it reported clean.
#
# "Somewhere acceptable" is the wrong question. The right one is "is this the exact
# thing the allowlist named", which is answered by resolving the path and requiring
# EQUALITY with the declared one. Any symlinked component makes the two differ,
# wherever it points, so it needs no list of forbidden destinations.
#
# source_assert_declared <dev-root> <rel-path>   → rc 0 if it may be copied, else 1
#   <dev-root> MUST already be physical (`pwd -P`), or every comparison is against a
#   path that does not exist, and everything is refused.

source_assert_declared() {
  local devroot="${1:-}" rel="${2:-}" src dir resolved
  [ -n "$devroot" ] && [ -n "$rel" ] || {
    echo "FATAL: source_assert_declared needs a dev root and a relative path" >&2; return 1; }
  src="$devroot/$rel"

  # Checked first and separately: `pwd -P` canonicalises the PARENT, so a symlinked
  # leaf survives this comparison intact and would otherwise be copied by value.
  if [ -L "$src" ]; then
    echo "FATAL: refusing to copy a symlink: $rel" >&2
    return 1
  fi
  if [ ! -f "$src" ]; then
    echo "FATAL: allowlisted source missing: $rel" >&2
    return 1
  fi

  dir="$(cd "$(dirname "$src")" 2>/dev/null && pwd -P)" || {
    echo "FATAL: cannot resolve the directory holding $rel" >&2; return 1; }
  resolved="$dir/$(basename "$src")"
  if [ "$resolved" != "$src" ]; then
    echo "FATAL: refusing to copy $rel: it resolves to" >&2
    echo "       $resolved" >&2
    echo "       which is not the path the allowlist names. A component of that" >&2
    echo "       path is a symlink, so the bytes come from somewhere the allowlist" >&2
    echo "       never named and would ship under a name that looks allowed." >&2
    return 1
  fi
  return 0
}
