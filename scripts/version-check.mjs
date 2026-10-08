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
 *
 * So `as of X.Y.Z` MUST track the current version and is rewritten every release; a bare
 * literal like "since 0.1.4" must NOT be, and is deliberately not matched here. An earlier
 * comment below stated that backwards, calling the `as of` marker immutable (#281).
 *
 * CASE-INSENSITIVE, and tolerant of `version`/`release`/`v` and of any whitespace including a
 * non-breaking space (#292). It knew ONE phrasing: `As of 0.1.4` fronted at the start of a
 * sentence, `as of version 0.1.4` and `as of v0.1.4` all passed. The published set holds
 * exactly one such sentence, so one copy-edit fronting that clause would have silenced this
 * rule permanently with nothing saying so. That is L21, in the same file as L22's fix.
 *
 * A bare literal is still untouched: `since 0.1.4` and `at or after 0.1.2` are not `as of`
 * claims and must never be rewritten.
 */
const AS_OF = /\bas\s+of\s+(?:version\s+|release\s+)?v?(\d+\.\d+\.\d+)\b/gi

/**
 * The release-tag instruction, and the edge of the rule above. `as of X.Y.Z` is prose that
 * tracks the version; `git verify-tag vX.Y.Z` is a COMMAND the reader runs against the
 * release in their hands. `public/SECURITY.md` told them to verify `v0.1.9` while 0.1.10
 * was being assembled, and `v0.1.8` at 0.1.9 (#277).
 *
 * THIS RULE HAS BEEN WRONG THREE TIMES, each time for the same reason: it RECOGNISED
 * fragments instead of VALIDATING the whole instruction, and skipped what it did not
 * understand.
 *
 *  - v1 scanned raw text for `verify-tag v<digits>`. Accepted `v0.1.10-rc.1` (`\b` ends at
 *    the hyphen), missed `"v0.1.9"` and `--verbose v0.1.9`, and REFUSED a changelog that
 *    correctly quoted a past release (#279, #281).
 *  - v2 added a marker, which fixed historical-versus-current, then recognised only
 *    backtick fences and so refused a valid `~~~` block holding the right tag.
 *  - v3 counted FILES rather than marker occurrences, so a duplicated section inside one
 *    document passed unchecked (#283); took the first non-dash token, so in
 *    `--format v0.1.10 v0.1.9` it compared the OPTION'S VALUE while the real tag went
 *    unseen (#284); accepted `# git verify-tag v0.1.10` as the instruction (#285); and
 *    ended the block at `~~~ not a closing fence`, which CommonMark does not (#286).
 *
 * SO THIS VERSION DOES NOT PARSE. It validates one template and REFUSES everything else,
 * which is L18's prescription — when the job is "nothing unexamined gets through", write the
 * allow-list, because a deny-list's blind spots are exactly the cases nobody thought of. The
 * refusals name the required shape, so a false refusal is loud and fixable, while a missed
 * stale instruction is silent and ships.
 */
const RELEASE_TAG_MARKER = '<!-- version-check: release-tag -->'
const ESCAPED_MARKER = RELEASE_TAG_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const IN_CODE_SPAN = new RegExp('`[^`]*' + ESCAPED_MARKER + '[^`]*`')

/** Quoted in every refusal, so the author is never left guessing what is permitted. */
const REQUIRED_SHAPE = `the designated instruction has ONE supported shape:

    ${RELEASE_TAG_MARKER}

    \`\`\`sh
    git verify-tag v<version>
    \`\`\`

The marker sits ALONE on its line, outside any fenced block, exactly once in the whole
published set. The very next non-blank line opens a fence (\`\`\` or ~~~), closed by the same
character, at least as long, with nothing after it but whitespace. Inside, EXACTLY ONE line is
\`git verify-tag <tag>\` — no options, one tag, no quotes. Other lines may be other commands or
# comments; a comment cannot supply the instruction. Anything else is refused rather than
interpreted.`

/**
 * A fence line. CommonMark gives a fence TWO conditions and the first version enforced only
 * the second (#288):
 *
 *   "The opening code fence may be indented up to three spaces … The closing code fence may
 *    be indented up to three spaces, and may be followed only by spaces or tabs."
 *
 * `^\s*` threw the indentation away, so a line indented four spaces — which Markdown reads as
 * INDENTED CODE, not a fence — closed the designated block early and a stale command below it
 * shipped. Verified against this repository's own marked@18.1.0: that input is ONE code token
 * holding both commands. The same blindness desynchronised the marker-occurrence count and
 * re-opened #283 (#290), which is why both scanners read fences through this one pair.
 *
 * ` {0,3}` and not `\s{0,3}`: a tab advances to the next multiple of four, so a tab-indented
 * line is indented code and correctly fails to match.
 */
const FENCE_RUN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const closes = (run, rest, open) =>
  run[0] === open[0] && run.length >= open.length && rest.trim() === ''

/**
 * One pass over a document. Returns the marker designations (a line that is NOTHING but the
 * marker, outside any fence) and the ambiguous mentions (the marker anywhere else outside a
 * fence). A mention INSIDE a fence is an example, not a designation, and is ignored — so a
 * document may one day document this convention without tripping the check that enforces it,
 * which is a false positive this project has already paid for once elsewhere.
 */
function markerSites(text) {
  // A trailing \r is stripped HERE, at the one split that owns it, because `.` does not match
  // \r in a JavaScript regex and `$` without /m will not match before it — so every fence line
  // in a CRLF document failed to parse and a correct instruction was REFUSED. Found in the
  // accept column, second sitting running (L22).
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const designations = []
  const ambiguous = []
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RUN.exec(lines[i])
    if (open === null) {
      if (m) {
        open = m[2]
        continue
      }
    } else {
      if (m && closes(m[2], m[3], open)) open = null
      continue
    }
    if (!lines[i].includes(RELEASE_TAG_MARKER)) continue
    // THREE ways the marker appears as literal TEXT rather than as a designation, and the
    // first version exempted only the first (#291). An indented code block is how a published
    // document quotes literal text — and four-space indentation is exactly how REQUIRED_SHAPE
    // prints the marker, so pasting this checker's own refusal into a document broke the build.
    // An inline code span is how a sentence names the marker, which is the sentence this
    // project will certainly write.
    if (/^ {4,}|^\t/.test(lines[i])) continue // indented code block
    if (IN_CODE_SPAN.test(lines[i])) continue // inline code span
    if (lines[i].trim() === RELEASE_TAG_MARKER) designations.push(i)
    else ambiguous.push(i + 1)
  }
  return { lines, designations, ambiguous }
}

/**
 * The block the marker designates: the next non-blank line must OPEN a fence, and nothing may
 * sit between them. No heading logic is needed, because anything that is not a fence opener is
 * already a refusal — which is also how a marker whose block sits under the next heading, or
 * past a setext underline, is refused (#286).
 *
 * Returns the block's lines, or a string naming why there is none.
 */
function designatedBlock(lines, at) {
  let i = at + 1
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length) return 'is the last thing in the document, with no command block'
  const m = FENCE_RUN.exec(lines[i])
  if (!m)
    return `is followed by ${JSON.stringify(lines[i].trim().slice(0, 40))} rather than a fence`
  const open = m[2]
  for (let j = i + 1; j < lines.length; j++) {
    const c = FENCE_RUN.exec(lines[j])
    if (c && closes(c[2], c[3], open)) return lines.slice(i + 1, j)
  }
  return 'opens a fenced block that is never closed'
}

// The ONE permitted spelling. No options, exactly one operand, no quotes — because skipping
// dash-prefixed tokens compared `--format`'s value and let the real tag through (#284), and
// collecting more tokens would only misclassify more of them.
const INSTRUCTION = /^git\s+verify-tag\s+(\S+)$/

/**
 * Read the designated block. EVERY non-blank line must fall into one of three permitted
 * categories, and anything else is refused:
 *
 *   1. the one permitted instruction spelling
 *   2. a full-line `#` comment — ignored, and unable to supply the instruction (#285)
 *   3. a context command carrying no version-shaped token
 *
 * WHY CATEGORY 3 IS A WHOLE-LINE TEST and not a `verify-tag` search. The first version refused
 * a non-conforming line only when it contained the string `verify-tag`, which left every other
 * line governed by a one-substring deny-list — L18's shape, inside the change that cites L18.
 * `git tag -v v0.1.9` is the SAME OPERATION (confirmed against git: both print
 * `error: tag 'v0.1.9' not found.`) and contains no such string, so a stale, visible, runnable
 * command passed beside the good one (#289). So did `git tag --verify`, a `git tag \` line
 * continuation, and `TAG=v0.1.9` read back through `"$TAG"`.
 *
 * A version-shaped token on any other line is therefore refused outright. That needs no option
 * parsing and no shell parsing, and the shipped block carries no version token.
 */
const VERSION_TOKEN = /\bv\d+\.\d+\.\d+/g

function instructionIn(block, pkg) {
  const tags = []
  const rejected = []
  for (const raw of block) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = INSTRUCTION.exec(line)
    if (m) {
      tags.push(m[1])
      continue
    }
    if (/verify-tag/.test(line)) {
      rejected.push([line.slice(0, 60), 'names verify-tag but is not the permitted spelling'])
      continue
    }
    const stale = (line.match(VERSION_TOKEN) ?? []).filter((v) => v !== `v${pkg}`)
    if (stale.length > 0) {
      rejected.push([
        line.slice(0, 60),
        `names ${stale.join(', ')}, and a command naming a release other than this one is ` +
          `refused wherever it sits in the block`,
      ])
    }
  }
  return { tags, rejected }
}

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (skip.has(e.name)) return []
    const p = join(dir, e.name)
    if (e.isDirectory()) return markdownFiles(p)
    return e.name.endsWith('.md') ? [p] : []
  })
}

/**
 * A version file that cannot be read or parsed is "I could not look", and that must arrive as a
 * REASON rather than as a stack trace escaping to the operator (#111, #293). The document root
 * already had this and these two did not, so the standard existed and this path was outside it.
 */
function read(f) {
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch (e) {
    console.error('version-check: FAILED')
    console.error(`  ✗ could not read ${f}: ${(e && e.code) || e}`)
    process.exit(1)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    console.error('version-check: FAILED')
    console.error(`  ✗ ${f} is not valid JSON: ${(e && e.message) || e}`)
    process.exit(1)
  }
}
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

// THE RELEASE-TAG INSTRUCTION. Occurrences are counted across the whole set, not documents
// (#283): counting files let a section duplicated INSIDE one document pass with its second,
// stale instruction never looked at. Every refusal below is a way for this rule to report
// success having validated nothing, which is #257's class and what v1 through v3 each shipped.
const designated = []
const ambiguous = []
for (const file of files) {
  const sites = markerSites(readFileSync(file, 'utf8'))
  for (const at of sites.designations) designated.push([file, sites.lines, at])
  for (const ln of sites.ambiguous) ambiguous.push(`${file}:${ln}`)
}

for (const where of ambiguous) {
  problems.push(
    `${where} mentions ${RELEASE_TAG_MARKER} but not alone on its line, so it designates ` +
      `nothing and is refused rather than guessed at — ${REQUIRED_SHAPE}`,
  )
}

if (designated.length !== 1) {
  problems.push(
    designated.length === 0
      ? `no published document designates the release-tag instruction, so it is checked ` +
          `nowhere — ${REQUIRED_SHAPE}`
      : `${designated.length} designations of ${RELEASE_TAG_MARKER} ` +
          `(${designated.map(([f, , at]) => `${f}:${at + 1}`).join(', ')}). Exactly one ` +
          `instruction is the designated one, and the others would go unchecked — ` +
          REQUIRED_SHAPE,
  )
} else {
  const [file, lines, at] = designated[0]
  const block = designatedBlock(lines, at)
  if (typeof block === 'string') {
    problems.push(`${file}: ${RELEASE_TAG_MARKER} ${block} — ${REQUIRED_SHAPE}`)
  } else {
    const { tags, rejected } = instructionIn(block, pkg)
    for (const [line, why] of rejected) {
      problems.push(
        `${file}: the designated block holds ${JSON.stringify(line)}, which ${why}. Refused ` +
          `rather than skipped, because an unsupported form must not hide beside a recognised ` +
          `one — ${REQUIRED_SHAPE}`,
      )
    }
    if (tags.length !== 1) {
      problems.push(
        tags.length === 0
          ? `${file}: the designated block runs no \`git verify-tag <tag>\` command, so the ` +
              `reader is told nothing to verify. A comment does not count — ${REQUIRED_SHAPE}`
          : `${file}: the designated block runs ${tags.length} verify-tag commands ` +
              `(${tags.join(', ')}). One instruction, one tag — ${REQUIRED_SHAPE}`,
      )
    }
    for (const tag of tags) {
      if (tag !== `v${pkg}`) {
        problems.push(
          `${file} tells the reader to run \`git verify-tag ${tag}\` but package.json says ` +
            `${pkg}. That command names the release being published, so it moves every ` +
            `release (#277). Compared as a whole token, so a prerelease is a different tag.`,
        )
      }
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
