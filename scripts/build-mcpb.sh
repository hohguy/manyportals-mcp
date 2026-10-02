#!/usr/bin/env bash
#
# Build the ManyPortals .mcpb bundle (one-click install into Claude Desktop).
#
# Publishes NOTHING — produces a local artifact at build/manyportals-mcp.mcpb.
# Packs from a clean staging dir so no repo cruft (src/, tests, project-docs,
# CLAUDE.md, dev deps) can leak into the bundle — the same discipline as the npm
# `files` allowlist. Requires network for the production dep install + the mcpb CLI.
#
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
STAGE="$ROOT/build/mcpb"
OUT="$ROOT/build/manyportals-mcp.mcpb"
source "$ROOT/scripts/staging-guard.sh" # nothing is removed unless this tool made it (#104)

# --- what the bundle MAY contain, and the audit over it -------------------------
#
# DERIVED from a packed bundle rather than remembered. `unzip -Z1` on a real build of
# this tree lists 1586 entries, 27 of them outside node_modules, and those 27 are
# exactly the rules below. Re-derive it the same way before changing it.
#
# It replaces a BLOCKLIST of seven names tested with `[ -e "$STAGE/$name" ]`, which had
# two independent defects. Both were reproduced against real bundles before this was
# written, which matters because the blocklist has never had anything to catch in a
# normal build, so running it proved nothing (#120):
#
#   - a fixed list of seven names, omitting `scripts`, `coverage`, `.env*`, `.github`
#     and `.git`. A staged `scripts/` printed "bundle audit clean", exited 0, and
#     produced a .mcpb carrying all 22 files of scripts/ — including publish-sync.sh,
#     which is on its own DENY_PATHS and is one of prepublish-guard.sh's private-tree
#     sentinels. The gate fired for what it named and packed the assembler.
#   - `[ -e "$STAGE/$p" ]` looks only at the stage ROOT. `dist/project-docs/notes.md`
#     was missed by a list that NAMES project-docs, one level down inside an
#     allowlisted directory, and shipped.
#
# So the question changed from "what did I stage" to "what is in the file we hand
# people". Every entry in the packed archive must match a rule here.
#
# Each rule, and why that file is in the bundle:
#   LICENSE         this project's MIT text; a redistributed artifact carries its licence
#   NOTICE          the third-party provenance notice (the shinzo curation boundary)
#   README.md       the PUBLIC readme, chosen by layout.sh below — the extension's docs
#   manifest.json   the manifest Claude Desktop installs from; `mcpb pack` validates it
#   package.json    REQUIRED at runtime, for the reason spelled out at its copy below:
#                   the server reads its own version from it and refuses to start without
#   dist/*.js       the compiled server, the only code that runs
#   node_modules/*  the production dependency tree, installed here by `npm ci` from the
#                   copied lockfile. Third-party, and not this repo's to enumerate — the
#                   same scope decision the credential scan below makes, for the same
#                   reason. A private file copied under node_modules/ would pass this,
#                   and nothing here pretends otherwise.
#
# `dist/*.js` rather than `dist/*`, and that IS the second defect above: a private tree
# copied under dist/ sits inside an allowlisted directory, so only the file type tells
# it from the compiled output. Every dist entry in a real bundle is a .js file, and that
# is a property of tsconfig.build.json, which sets declaration, declarationMap and
# sourceMap to false, not just an observation about one build.
#
# NOT listed, because the archive does not contain them although the build stages them:
# `.mcpbignore`, `package-lock.json` and `.manyportals-staging`. The first two are
# dropped by @anthropic-ai/mcpb's own EXCLUDE_PATTERNS and the third by .mcpbignore.
# That makes this list a tripwire on the MCPB_VERSION bump below as well: a packer that
# stops stripping package-lock.json fails this audit instead of shipping it in silence.
BUNDLE_ALLOW=(
  'LICENSE'
  'NOTICE'
  'README.md'
  'manifest.json'
  'package.json'
  'dist/*.js'
  'node_modules/*'
)

# bundle_archive_audit — read an archive listing on STDIN, one entry per line, and
# refuse anything BUNDLE_ALLOW does not cover.
#
#   0  every entry is allowed; a one-line summary on stdout
#   1  entries were refused; they are named on stderr
#   2  cannot verify (an empty listing, or an empty allowlist) — the caller fails closed
#
# It takes a LISTING rather than a path to a .mcpb on purpose. A synthetic listing is
# the input that makes this fire, and a test that has to build a bundle to produce one
# is slow enough to get skipped, which is how a guard stops guarding. `--audit-archive`
# just below is this same function with a shell around it, and the real build at the
# bottom of this file calls it directly; there is one copy of the decision.
bundle_archive_audit() {
  local entry pat allowed seen=0 refused=0 names=''
  # An allowlist with nothing in it allows nothing, so an empty one is loud rather than
  # dangerous. It is still refused here rather than left implicit, because "the check
  # was satisfied by deleting its own input" is this repo's most common defect. Said
  # plainly: no input reaching this function can drive this branch, so no test pins it.
  [ "${#BUNDLE_ALLOW[@]}" -gt 0 ] || {
    echo "bundle audit: the allowlist is empty — cannot verify; failing closed" >&2
    return 2; }
  # `|| [ -n "$entry" ]` so a final line with no trailing newline is still read. An
  # archive entry whose name contains a newline splits into two lines here, neither of
  # which can match a rule, so it is refused — which is the direction to fail in.
  while IFS= read -r entry || [ -n "$entry" ]; do
    [ -n "$entry" ] || continue
    seen=$((seen + 1))
    allowed=0
    # Refused before any pattern sees it: an absolute entry, a doubled slash, or a `..`
    # component. `dist/../private.js` matches `dist/*.js` and denotes somewhere else,
    # which is the out-guard dot-leaf shape — a path compared as one thing while naming
    # another (#106). Wrapping in slashes makes the three cases one pattern and covers
    # a bare `..` as well. A trailing-slash DIRECTORY entry lands here too; a real build
    # emits none (measured: zero of 1586), so a packer that starts emitting them changes
    # what ships and should stop the build rather than be accommodated in advance.
    case "/$entry/" in
      *//*|*/../*) allowed=0 ;;
      *)
        for pat in "${BUNDLE_ALLOW[@]}"; do
          # $pat is UNQUOTED so the shell reads it as a pattern; $entry is quoted so it
          # is read as a literal subject. `*` matches `/` here, which is what makes
          # `node_modules/*` cover the whole dependency tree and `dist/*.js` cover
          # nested modules.
          case "$entry" in
            $pat) allowed=1; break ;;
          esac
        done
        ;;
    esac
    if [ "$allowed" -eq 1 ]; then continue; fi
    refused=$((refused + 1))
    names="$names  $entry"$'\n'
  done
  # An empty listing is not a clean bundle. Without this the audit is satisfied by
  # handing it nothing, which is the same shape as a rule table with no rules.
  [ "$seen" -gt 0 ] || {
    echo "bundle audit: the archive listing is EMPTY, so nothing was checked — failing closed" >&2
    return 2; }
  if [ "$refused" -gt 0 ]; then
    echo "bundle audit: $refused of $seen archive entries are not on the bundle allowlist:" >&2
    printf '%s' "$names" | sed -n '1,40p' >&2
    return 1
  fi
  echo "  ✓ archive audit clean ($seen entries, every one allowlisted)"
  return 0
}

# An entry point that takes a listing and does nothing else, so src/build-mcpb.test.ts
# can drive the decision above with a synthetic one in milliseconds instead of building
# a bundle. It is placed HERE, before the first line of real work, so that stays true.
if [ "${1:-}" = "--audit-archive" ]; then
  shift
  [ "$#" -eq 0 ] || {
    echo "build-mcpb: --audit-archive reads a listing on stdin and takes no argument (got: $1)" >&2
    exit 2; }
  AUDIT_RC=0
  bundle_archive_audit || AUDIT_RC=$?
  # Spelled out rather than `exit $AUDIT_RC`: a non-literal exit status is invisible to
  # guard-register's refusal inventory, and idiom-check forbids it for that reason (#124).
  if [ "$AUDIT_RC" -eq 0 ]; then exit 0; fi
  if [ "$AUDIT_RC" -eq 2 ]; then exit 2; fi
  exit 1
fi

echo "==> building dist"
npm run build >/dev/null

echo "==> staging bundle at build/mcpb"
# These paths are DERIVED rather than supplied, so the risk here is lower than in
# publish-sync. That is a property of how this script happens to be called, which is
# exactly the assumption that rots, so it gets the same guard (#104).
mkdir -p "$ROOT/build"
staging_wipe "$STAGE" "bundle staging dir" || exit 1
staging_wipe_file "$OUT" "$ROOT/build" || exit 1
staging_claim "$STAGE"
cp manifest.json LICENSE NOTICE .mcpbignore "$STAGE/"
# Ship the PUBLIC-facing README: in the dev repo it lives at public/README.md; in
# the assembled public repo the root README.md IS already the public one.
#
# This was `if [ -f public/README.md ]; then ... else cp README.md ...`, and the
# fallback is the whole problem: the dev root README references private docs that
# never ship, so a MISSING public/README.md silently bundled it. On this volume that
# absence is not hypothetical, because the sync evicts and resurrects files. And the
# bundle audit cannot catch it, since the internal-reference gate lives only in
# publish-sync.sh and never runs here (#110 5c).
#
# So the layout decides which file is correct, and a missing one is refused rather
# than substituted. Choosing by presence is what made the wrong file a valid answer.
# shellcheck source=scripts/layout.sh
. "$ROOT/scripts/layout.sh"
BUNDLE_LAYOUT="$(mp_layout "$ROOT")" || exit 1
if [ "$BUNDLE_LAYOUT" = dev ]; then README_SRC="public/README.md"; else README_SRC="README.md"; fi
[ -f "$README_SRC" ] || {
  echo "  ✗ the $BUNDLE_LAYOUT tree has no $README_SRC — refusing to bundle a substitute" >&2
  staging_wipe "$STAGE" "bundle staging dir" || exit 1
  exit 1
}
cp "$README_SRC" "$STAGE/README.md"

# The bundle ships the README and NOT the documents it links to: `docs` is on the surface
# blocklist, so docs/USAGE.md and the rest cannot be here. 11 of the 13 relative links
# were therefore dead inside the artifact, and the breakage was structural rather than
# accidental (#140). Nothing noticed because docs-links.mjs scopes itself to a TREE, and
# the thing that ships is an archive.
#
# So the links point at the public repository, which is where the manifest's own
# `documentation` field already sends people. `main` is always the latest release, so a
# blob URL on main needs no per-release edit.
#
# EVERY relative link is rewritten, including LICENSE and NOTICE, which ARE in the
# bundle. One rule is easier to state and to check than a keep-list, and it makes the
# assertion afterwards simply "no relative link survived".
#
# A HEREDOC, not an inline -e: the script contains quotes and backticks, and the first
# version of this broke the shell's own parsing three lines further down.
#
# NOT PINNED BY A TEST, said here rather than left for a green suite to imply. The
# check below is a postcondition over this script's own rewrite: no caller-supplied
# input reaches it, so there is no input a test could use to make it fire. Verified by
# running it instead, and recorded with the release: 13 relative links rewritten, 0
# remaining, 21 absolute links in the bundled README.
# The path arrives by ENVIRONMENT, not argv: `node -` reads the script from stdin and
# leaves "-" sitting in argv[1], so the first version opened a file called "-".
if ! BUNDLE_README="$STAGE/README.md" node - <<'REWRITE_LINKS'
const fs = require('fs')
const base = 'https://github.com/hohguy/manyportals-mcp/blob/main/'
const rel = /\]\((?!https?:|#|mailto:)([^)]+)\)/g
const path = process.env.BUNDLE_README
const before = fs.readFileSync(path, 'utf8')
const rewritten = before.replace(rel, (_m, target) => '](' + base + target + ')')
fs.writeFileSync(path, rewritten)
const left = [...rewritten.matchAll(rel)].map((m) => m[1])
if (left.length > 0) {
  process.stderr.write('relative links survived: ' + left.join(', ') + '\n')
  process.exit(1)
}
process.stdout.write('  rewrote ' + ((before.match(rel) || []).length) + ' relative link(s) in the bundle README\n')
REWRITE_LINKS
then
  echo "  the bundle README still holds relative links, which do not resolve inside a bundle" >&2
  staging_wipe "$STAGE" "bundle staging dir" || exit 1
  exit 1
fi
cp -R dist "$STAGE/dist"
# package.json is REQUIRED in the bundle, for two reasons — neither of them node's
# module system: it drives the production dependency install below, and the server
# reads its own version from it at startup (packageVersion) and REFUSES to start
# when it is missing. "type": "module" declares the ESM dist, but node detects that
# on its own (module-syntax detection, default since v22.7.0), so that is not why.
cp package.json package-lock.json "$STAGE/"

echo "==> installing production dependencies into the bundle (no dev deps, no scripts)"
# `npm ci`, not `npm install`: the lockfile was copied in above precisely so the
# bundled dependency graph is pinned. `npm install` is free to resolve differently
# later and can rewrite the lockfile (#72).
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )

# Gate the bundle before packing: no credential material and no unexpected surface
# in what we staged (mirror of publish-sync.sh's audit; node_modules is third-party
# and excluded). Fail-closed — wipe and abort rather than ship a leak.
echo "==> auditing the staged bundle"
# This used to be a SECOND copy of the tree scan, written here so it could exclude
# node_modules, and the copy is where #108 M1 lived: `if grep ... >/dev/null 2>&1`
# made rc=2 falsy, so "I could not read part of the tree" skipped the leak branch and
# the bundle was PACKED. grep reports an error in preference to a match, so it can
# find the credential and still return 2. A synthetic PAT in the staged copy plus one
# injected grep error produced "✓ bundle audit clean" and a real .mcpb holding the
# token. The sibling scanner had carried the correct three-way handling since #65 and
# it was never swept here, which is the L1 lesson exactly.
#
# So there is now one scanner. Its rc=2 path is tested in src/cred-scan-tree.test.ts.
#
# node_modules stays excluded, and that is a scope decision rather than an oversight:
# it SHIPS inside the bundle, so a credential there ships too, but scanning it is not
# viable here. Measured: `cred-scan-tree.sh node_modules` ran for FOUR HOURS without
# finishing, and a plain `find node_modules -type f` does not finish in a minute.
#
# WHY it is that slow is NOT established. It was first attributed to this repo living
# on a cloud-synced folder faulting evicted files back down; that was a guess from a
# known property of the machine, and it is wrong, because the sync was paused for this
# work. The honest statement is that the numbers are measured and the cause is not.
# Tracked as #118. The contents are also third-party, which is an independent reason
# to leave them out. Scope is tracked on #110.
CRED_RC=0
CRED_HITS="$(bash "$ROOT/scripts/cred-scan-tree.sh" "$STAGE" --exclude-dir=node_modules 2>&1)" || CRED_RC=$?
if [ "$CRED_RC" -ne 0 ]; then
  if [ "$CRED_RC" -eq 1 ]; then
    echo "  ✗ LEAK: credential material in the staged bundle:" >&2
  else
    echo "  ✗ CANNOT VERIFY the bundle credential scan (rc=$CRED_RC) — failing closed" >&2
  fi
  printf '%s\n' "$CRED_HITS" | sed 's/^/      /' >&2
  staging_wipe "$STAGE" "bundle staging dir" || exit 1
  staging_wipe_file "$OUT" "$ROOT/build" || exit 1
  exit 1
fi
# KEPT, and demoted rather than deleted (#120). The archive allowlist at the bottom of
# this file is now the gate; this loop is a fast fail, and it earns its place twice:
#
#   - it fires BEFORE the production dependency install and before packing, and it can
#     WIPE THE STAGE. By the time the archive audit runs, the artifact exists and the
#     only remedy left is to delete it.
#   - it is the ONLY check that can see a staged file the packer strips. `.env*` and
#     `.DS_Store` never reach the archive, so the allowlist is structurally blind to
#     them; a staged `.env` is a finding even when it does not ship.
#
# What it does NOT do, stated here rather than implied by an encouraging message. It is
# seven names tested at the stage ROOT. It cannot see `scripts`, `coverage`, `.env*`,
# `.github` or `.git`, and it cannot see any of the seven one level down. Both gaps are
# verified, not theorised, and both are now covered for anything that actually SHIPS by
# the archive allowlist. The residual is a staged file that the packer would strip:
# credential material in one is caught by the scan just above, and a placeholder file
# is not a leak, which is why this list is left as it was rather than half-extended.
for p in project-docs CLAUDE.md HANDOFF.md .claude src docs public; do
  if [ -e "$STAGE/$p" ]; then
    echo "  ✗ LEAK: unexpected surface in the staged bundle: $p — refusing to pack" >&2
    staging_wipe "$STAGE" "bundle staging dir" || exit 1
    staging_wipe_file "$OUT" "$ROOT/build" || exit 1
    exit 1
  fi
done
# Says what was checked. It used to read "bundle audit clean (no credential material, no
# private surface)", which is a claim about the whole surface backed by seven name tests
# at one level, and it was printed over a bundle carrying all of scripts/.
echo "  ✓ staged tree: no credential material, and none of the seven denied names at its root"

# Pinned: an unpinned `npx @anthropic-ai/mcpb` fetches whatever is latest, so two builds of
# the same commit could differ, and a compromised release of the packer would be pulled in
# silently (review 2026-09-27). Bump this deliberately.
MCPB_VERSION="2.1.2"

# NOT byte-reproducible, and this is the honest place to say so (#72). `mcpb pack`
# stamps its own timestamps into the ZIP headers and ignores source mtimes: two builds
# of an unchanged tree differ at byte 11. Verified by normalizing every staged mtime to
# a fixed date and observing the archive still carry the build wall-clock, and by
# `mcpb pack --help`, which offers no options at all. So the sha256 in the release
# notes identifies THE ARTIFACT WE PUBLISHED, for download integrity; it is not a
# value anyone can re-derive from source, and nothing here should claim otherwise.
# What a verifier CAN do is extract the bundle and compare dist/ and manifest.json
# against their own build.

echo "==> packing .mcpb (via npx @anthropic-ai/mcpb@$MCPB_VERSION — not a project dependency)"
npx --yes "@anthropic-ai/mcpb@$MCPB_VERSION" pack "$STAGE" "$OUT"

# THE gate on what ships. Everything above audits the staging tree; this audits the
# file people are handed, which is the only surface that is actually redistributed
# (#120). The staging marker check is the older, narrower half: the marker lives on
# disk between runs so a later run may remove this directory, and .mcpbignore keeps it
# out of the archive. Prove that rather than trust it (#104).
command -v unzip >/dev/null 2>&1 || {
  echo "  ✗ unzip is not available, so the bundle contents cannot be verified — failing closed" >&2
  staging_wipe_file "$OUT" "$ROOT/build" || true  # idiom-ok: best-effort cleanup on a path that already failed; the exit status below is the gate
  exit 1
}
# Captured, NOT piped into grep -q. Under `set -o pipefail`, grep -q exits the moment
# it matches, the producer dies of SIGPIPE, and the pipeline reports 141 — which the
# `if` reads as "no match". The gate's failure mode was to PASS, and it was the
# pipefail intended to make the script safer that caused it. Proven: with the
# .mcpbignore entry removed the marker WAS in the archive and the build still exited 0.
#
# `-Z1` rather than `-l`, and the reason is #125 rather than taste. `unzip -l` prints
# length, date and time before the name, so recovering the path means cutting a
# formatted line back apart, and a path reconstructed from delimited output is exactly
# what let one file inherit another's exemption. `-Z1` prints the name and nothing else,
# one per line, so nothing here reconstructs anything.
ARCHIVE_LIST="$(unzip -Z1 "$OUT")" || {
  echo "  ✗ could not read the packed bundle to verify its contents — failing closed" >&2
  staging_wipe_file "$OUT" "$ROOT/build" || true  # idiom-ok: best-effort cleanup on a path that already failed; the exit status below is the gate
  exit 1
}
case "$ARCHIVE_LIST" in
  *"$STAGING_MARKER"*)
    echo "  ✗ the staging marker was packed into the bundle — refusing to ship it" >&2
    staging_wipe_file "$OUT" "$ROOT/build" || true  # idiom-ok: best-effort cleanup on a path that already failed; the exit status below is the gate
    exit 1
    ;;
esac
# The allowlist would refuse the marker too, since it is on no rule. This narrower check
# stays because it names the CAUSE, and a generic "not allowlisted" over an internal
# artifact is the kind of finding someone talks themselves out of.
#
# A HERE-STRING, not a pipe. The comment above this capture is about a pipeline whose
# status came back 141; `<<<` writes a temp file and the function reads a file, so there
# is no producer to signal and no pipeline status to misread.
ARCHIVE_RC=0
bundle_archive_audit <<< "$ARCHIVE_LIST" || ARCHIVE_RC=$?
if [ "$ARCHIVE_RC" -ne 0 ]; then
  if [ "$ARCHIVE_RC" -eq 1 ]; then
    echo "  ✗ the packed bundle holds files the bundle is not allowed to contain — refusing to ship it" >&2
  else
    echo "  ✗ CANNOT VERIFY the packed bundle's contents (rc=$ARCHIVE_RC) — failing closed" >&2
  fi
  staging_wipe_file "$OUT" "$ROOT/build" || true  # idiom-ok: best-effort cleanup on a path that already failed; the exit status below is the gate
  exit 1
fi

echo "==> done"
ls -lh "$OUT"
