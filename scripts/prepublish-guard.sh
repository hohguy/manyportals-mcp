#!/usr/bin/env bash
#
# prepublish-guard.sh — wired as npm `prepublishOnly`: the LAST gate before an
# `npm publish` uploads. Refuses to publish if the working tree still contains a
# PRIVATE surface (i.e. you are publishing from the dev repo, or a private file
# leaked into the assembled public repo) or any credential-shaped literal.
#
# Defense in depth behind `private:true` (blocks a dev-repo publish) and
# publish-sync.sh's default-deny allowlist (assembles a clean public repo). This
# runs at the moment of publish, in whatever tree npm is about to pack — so it is
# the check that fires if someone runs `npm publish` from the wrong place.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
fail=0

# High-confidence sentinels: any of these present ⇒ this is the private dev repo
# (or a leak), never the assembled public repo. Not the full deny-list (that is
# publish-sync.sh's assembly-time audit) — just the unambiguous "wrong tree" tells.
DEV_TREE=0
for p in project-docs CLAUDE.md HANDOFF.md .claude scripts/publish-sync.sh; do
  if [ -e "$p" ]; then
    echo "prepublish-guard: REFUSING publish — private surface present: $p" >&2
    fail=1
    DEV_TREE=1
  fi
done
if [ "$fail" -ne 0 ]; then
  echo "  Publish ONLY from the public repo assembled by scripts/publish-sync.sh — never the dev repo." >&2
fi

# Re-run the shared credential scan over the shipped surfaces (mirror of the CI gate).
bash "$ROOT/scripts/credscan.sh" || fail=1

# `files[]` is what npm actually ships, and `dist/` — the executable content, and the
# target of `bin` and `main` — is git-ignored, so credscan never sees it. Publishing
# without a build produced a complete tarball with no dist/ and this guard still said
# "publish may proceed" (#61). Assert every named path exists, then scan the built
# output itself.
# Only meaningful in the PUBLIC tree: files[] names the public layout (docs/SAFETY.md
# and friends are remapped at assembly), so those paths are absent from the dev repo
# by design and the guard has already refused above.
if [ "$DEV_TREE" -eq 0 ]; then
# Existence of the named paths is not enough: `dist` is a DIRECTORY in files[], and a
# present-but-empty one satisfied `existsSync` while npm packed no entry point at all
# (#110 5d). The things that must actually be there are `main` and every `bin` target,
# and they must be non-empty files.
MISSING="$(node -e '
  const fs=require("fs");
  const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));
  const gone=(pkg.files||[]).filter(f=>!fs.existsSync(f));
  const entries=[pkg.main, ...Object.values(pkg.bin||{})].filter(Boolean);
  for (const e of entries) {
    let st=null;
    try { st=fs.statSync(e); } catch { gone.push(e+" (entry point, missing)"); continue; }
    if (!st.isFile()) gone.push(e+" (entry point, not a file)");
    else if (st.size===0) gone.push(e+" (entry point, empty)");
  }
  if(gone.length) console.log(gone.join(" "));
')" || { echo "prepublish-guard: cannot read package.json — failing closed" >&2; fail=1; }
if [ -n "${MISSING:-}" ]; then
  echo "prepublish-guard: REFUSING publish — files[] names paths that do not exist: $MISSING" >&2
  echo "  Run 'npm ci && npm run build' first; a published package whose bin/main is" >&2
  echo "  absent installs and then fails on first run." >&2
  fail=1
fi
# Scan the set npm ACTUALLY packs, asked of npm rather than inferred (#110 5a).
#
# credscan sees GIT's view, and npm's files[] OVERRIDES ignore rules. Three
# git-ignored files under examples/ carrying synthetic credentials were reported
# clean by every git-based gate and packed by npm. Scanning only dist/ missed them
# because dist/ was never where they were.
#
# --ignore-scripts so this cannot re-enter itself through a lifecycle hook.
# shellcheck source=scripts/cred-pattern.sh
PATTERN="$ROOT/scripts/cred-pattern.sh"
[ -f "$PATTERN" ] || {
  echo "prepublish-guard: missing $PATTERN — cannot verify; failing closed" >&2; fail=1; }
. "$PATTERN"
[ -n "${CRED:-}" ] || {
  echo "prepublish-guard: the CRED pattern is empty — cannot verify; failing closed" >&2; fail=1; }

# The pack list stays a PARSED ARRAY and is never turned into shell text (#122).
#
# This block used to print npm's paths one per line and walk them with `while read`.
# A packed filename containing a NEWLINE then became two list entries, neither of
# which is a real path, and the completeness assertion below compared two counts
# derived from that same corrupted list — so it agreed with itself. Measured, not
# theorised: a git-ignored `examples/PORTAL_A<LF>NOTICE` holding a PAT, beside a
# benign `examples/PORTAL_A` and a benign `NOTICE`, produced "scanned all 6", clean,
# rc 0, while npm packed 5 files and the tarball carried the credential. Both halves
# of the split name happened to be real files, so both were opened and counted and
# the two counters matched.
#
# Emitting NUL-separated paths instead does NOT fix it: a bash variable cannot hold a
# NUL byte, so `$(...)` truncates at the first one and the same corruption returns in
# a harder form. The enumeration and the scan therefore both live here, and each path
# reaches grep as a single argv element — no shell, so nothing splits it.
#
# grep stays the matching engine deliberately. cred-pattern.sh is the ONE definition
# of the credential shape for the shell gates, with a single TS mirror held to it by a
# parity test; re-expressing its ERE as a JS RegExp here would add a third, unguarded
# evaluation site, and grep also streams rather than reading each file into memory.
PACK_RC=0
CRED="${CRED:-}" node -e '
  const {execFileSync,spawnSync}=require("child_process");
  const fs=require("fs");
  const cred=process.env.CRED;
  if(!cred) throw new Error("the CRED pattern did not reach the scanner");
  const out=execFileSync("npm",["pack","--dry-run","--json","--ignore-scripts"],{encoding:"utf8"});
  const entries=JSON.parse(out);
  const files=((entries[0]||{}).files||[]).map(f=>f.path);
  if(files.length===0) throw new Error("npm reported an EMPTY pack list");
  let packed=0, scanned=0, refuse=false;
  const hits=[];
  for(const p of files){
    packed++;
    let st=null;
    try { st=fs.statSync(p); } catch { continue; }
    if(!st.isFile()) continue;
    const g=spawnSync("grep",["-a","-l","-E","--",cred,p],
      {env:{...process.env,LC_ALL:"C"},stdio:["ignore","ignore","pipe"]});
    const grc=g.error?-1:g.status;
    if(grc===null||grc<0||grc>1){
      process.stderr.write("prepublish-guard: cannot scan "+JSON.stringify(p)+" (rc="+grc+") — failing closed\n");
      refuse=true;
      continue;
    }
    scanned++;
    if(grc===0) hits.push(p);
  }
  if(hits.length){
    process.stderr.write("prepublish-guard: REFUSING publish — credential material in a file npm would PACK:\n");
    // JSON.stringify so a control character in a name is VISIBLE, and so one hit can
    // never be read as two paths — the failure this block exists to remove.
    for(const p of hits) process.stderr.write("  "+JSON.stringify(p)+"\n");
    process.stderr.write("  These are invisible to the git-based scans when git-ignored; files[] overrides ignore rules.\n");
    refuse=true;
  }
  // Every packed file must have been examined. Otherwise a run that skipped most of
  // the tarball reports the same "clean" as one that read all of it. Both counters
  // are incremented over the parsed array above, never over a reserialized copy.
  if(scanned!==packed){
    process.stderr.write("prepublish-guard: examined "+scanned+" of the "+packed+" file(s) npm would pack — failing closed\n");
    refuse=true;
  } else {
    console.log("prepublish-guard: scanned all "+packed+" file(s) npm would pack");
  }
  if(refuse) process.exit(2);
' || PACK_RC=$?
if [ "$PACK_RC" -eq 2 ]; then
  # The scanner refused and already named which of its checks fired.
  fail=1
elif [ "$PACK_RC" -ne 0 ]; then
  echo "prepublish-guard: cannot ask npm what it would pack (rc=$PACK_RC) — failing closed" >&2
  fail=1
fi
fi   # end: public-tree-only checks

if [ "$fail" -ne 0 ]; then
  echo "prepublish-guard: aborting publish." >&2
  exit 1
fi
echo "prepublish-guard: clean — no private surfaces or credential material; publish may proceed."
