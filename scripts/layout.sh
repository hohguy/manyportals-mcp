#!/usr/bin/env bash
#
# layout.sh — which tree am I in? (#107)
#
# The scripts that SHIP need to know whether they are running in the private dev repo
# (docs authored under public/, examples under docs/) or in the assembled public repo
# (the same files at the root). They used to answer it with `[ -d public ]`.
#
# In the public repo that directory does not exist, until a contributor makes one, and
# `public/` is among the most ordinary directory names in the JS ecosystem. An empty
# directory flipped the credential scan to the dev pathspec, which excludes docs/*.md,
# and it printed "clean" while scanning nothing. No adversary required.
#
# So the tree DECLARES what it is, in a file nobody creates by accident, and anything
# that cannot be read as exactly `dev` or `public` FAILS CLOSED. Guessing a layout is
# how the previous version produced a confident wrong answer.
LAYOUT_MARKER='.manyportals-layout'

# mp_layout — prints `dev` or `public`, or exits 1 with a reason.
mp_layout() {
  local root="${1:-.}" value
  # The character classes below must mean the same thing on every machine, so the
  # locale is pinned here rather than inherited. Assigning LC_ALL takes effect for
  # pattern matching inside this function and is restored on return.
  local LC_ALL=C
  if [ ! -f "$root/$LAYOUT_MARKER" ]; then
    echo "FATAL: no $LAYOUT_MARKER in $root, so which file set to scan is unknown." >&2
    echo "       Refusing to guess: guessing is what made an empty directory named" >&2
    echo "       'public' turn these checks off (#107)." >&2
    return 1
  fi
  # ONE normalisation, SPECIFIED here and mirrored in layout.mjs, rather than each
  # reader inheriting whatever its language's trim happens to do. Two readers of one
  # declaration that disagree is the defect, more than either answer is (#127):
  #
  #   - an optional leading UTF-8 BOM is dropped. Windows editors write one and it
  #     carries no meaning. `.trim()` removed it and `tr -d '[:space:]'` did not, so a
  #     marker saved from Notepad read as `dev` to every node tool and refused in every
  #     shell gate. This repository has Windows CI, so that was reachable.
  #   - ASCII whitespace is trimmed from the two ENDS only. The old `tr -d` deleted it
  #     everywhere, which accepted `d e v` as `dev` and `pub lic` as `public`, and
  #     credscan then applied the wrong pathspec while reporting clean.
  #   - nothing else is normalised. A non-breaking space is not whitespace here, and is
  #     refused by both readers: a marker that LOOKS like `dev` and is not should say so
  #     rather than be guessed at, which is the whole of #107.
  value="$(cat "$root/$LAYOUT_MARKER")"
  value="${value#$'\xef\xbb\xbf'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    dev|public) printf '%s' "$value" ;;
    *)
      echo "FATAL: $LAYOUT_MARKER says '$value'; expected exactly 'dev' or 'public'." >&2
      return 1
      ;;
  esac
}
