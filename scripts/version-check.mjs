// Check that the version agrees across every surface a release edits BY HAND.
//
// The agreement is a real constraint, deliberately adopted, and until now it was
// enforced by a human reading a maintainer checklist, which puts it this way: since
// 0.1.4 the npm package version and the bundle manifest version are deliberately the
// SAME, and a difference means `doctor` is reporting a different build than the one the
// client actually installed.
//
// A release touches package.json, manifest.json and a prose line in the published
// documents, in three separate edits, and nothing compared them. The prose half is the
// dangerous one: a status sentence that must track a mechanical value and cannot be
// diffed against anything drifts silently, and a reader takes "as of 0.1.4" as current
// (#129).
//
// SCOPE, stated so nobody reads more into a green run. This compares version STRINGS.
// It does not check that any document is otherwise current: no check in this repository
// does that, and #94 is where that gap is tracked.
//
// Two layouts, one rule set, read from the tree's own declaration rather than sniffed
// for a directory named `public` (#107) — the same choice docs-links.mjs makes.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mpLayout } from './layout.mjs'

const root = mpLayout('.') === 'dev' ? 'public' : '.'
const skip = new Set(['node_modules', '.git', 'dist', 'build'])

/**
 * The marker. Scoped to an explicit phrase rather than to any version-shaped string,
 * because a HISTORICAL reference must not be rewritten. A maintainer checklist names
 * 0.1.2 and 0.1.4 as thresholds that were true then and stay true; a rule flagging every
 * version literal would demand those be edited on every release, which is how a check
 * teaches people to ignore it.
 */
const AS_OF = /\bas of (\d+\.\d+\.\d+)\b/g

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (skip.has(e.name)) return []
    const p = join(dir, e.name)
    if (e.isDirectory()) return markdownFiles(p)
    return e.name.endsWith('.md') ? [p] : []
  })
}

const read = (f) => JSON.parse(readFileSync(f, 'utf8'))
const problems = []

/**
 * The TAG is the third surface that can drift, and it is the one nothing could check
 * from inside the tree: at verify time there is no tag yet. `--tag v0.2.0` is how the
 * release step asks this question, so the runbook does not have to trust an eye.
 * A v0.2.0 tag on a 0.1.4 bundle is the mismatch nobody notices until someone reports
 * the wrong version (#35).
 */
const tagArg = process.argv.indexOf('--tag')
const tag = tagArg === -1 ? null : process.argv[tagArg + 1]
if (tagArg !== -1 && (tag === undefined || !tag.startsWith('v'))) {
  console.error('version-check: FAILED')
  console.error(`  ✗ --tag needs a tag of the form vX.Y.Z (got ${JSON.stringify(tag)}).`)
  process.exit(1)
}

const pkg = read('package.json').version
if (typeof pkg !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg)) {
  problems.push(`package.json has no usable version (got ${JSON.stringify(pkg)}).`)
}

const manifest = read('manifest.json').version
if (manifest !== pkg) {
  problems.push(
    `manifest.json says ${JSON.stringify(manifest)} and package.json says ` +
      `${JSON.stringify(pkg)}. They are deliberately the same since 0.1.4: a difference ` +
      `means doctor reports a different build than the installed extension.`,
  )
}

// A root that cannot be read is "I could not look", not "there is nothing there", and
// the two must not collapse into one branch (#111). Without this the throw escapes as a
// stack trace: still a non-zero exit, but by accident rather than by design, and the
// operator reads a crash instead of a reason.
let files
try {
  files = markdownFiles(root)
} catch (e) {
  console.error('version-check: FAILED')
  console.error(`  ✗ could not read ${root}/ to check its documents: ${(e && e.code) || e}`)
  process.exit(1)
}

if (tag !== null && tag !== `v${pkg}`) {
  problems.push(
    `the tag ${tag} does not match package.json ${pkg}. The release is cut against the ` +
      `tag, so this is what puts a vX.Y.Z label on a different build.`,
  )
}

let scanned = 0
for (const file of files) {
  scanned++
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(AS_OF)) {
    if (m[1] !== pkg) {
      problems.push(`${file} says "as of ${m[1]}" but package.json says ${pkg}.`)
    }
  }
}

// A scan with nothing to look at is not a pass. The published set is never empty, so an
// empty result means the layout resolved somewhere unexpected.
if (scanned === 0) {
  problems.push(`no documents were found under ${root}/, so nothing was checked.`)
}

if (problems.length > 0) {
  console.error('version-check: FAILED')
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log(
  `version-check: clean — ${pkg} agrees across package.json, manifest.json and ${scanned} document(s)`,
)
