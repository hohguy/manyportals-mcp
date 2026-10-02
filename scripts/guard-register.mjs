#!/usr/bin/env node
/**
 * guard-register — prove that each guard can FAIL (#93).
 *
 * WHY. The dominant defect class in this repo is a guard whose failure mode is to
 * report success. Seven distinct instances in one session, across shell and
 * TypeScript: a composition-root line that left the suite green when replaced with a
 * hardcoded value; an egress regex asserted only in the empty direction; a test fake
 * stricter than production; a credential gate that printed clean once its pattern
 * file was deleted; a gate that swallowed grep's rc=2; a gate that read SIGPIPE as
 * "no match"; a stat probe whose fallback never ran because the first call succeeded
 * with different semantics. Every one was found by a person choosing to test in the
 * failing direction. This is that choice, made mechanical.
 *
 * WHAT IT DOES, per entry: run the named test and require it to PASS (so a stale
 * entry cannot masquerade as a working guard), apply a one-line mutation that removes
 * the guard, run the same test and require it to FAIL, then restore.
 *
 * Three properties it needs, all learned the hard way here:
 *  - It MUTATES source. Backups are taken per run, restore happens in a finally and
 *    on SIGINT, and the restored file is compared byte for byte. A restore that does
 *    not match aborts loudly rather than leaving a mutated tree.
 *  - A registry entry whose `find` no longer matches is a FAILURE, not a skip. That is
 *    how a guard deleted in a refactor announces itself.
 *  - It cannot hollow out. An absent file is tolerated only for entries marked
 *    devOnly, and the run asserts a minimum number of entries actually exercised, so
 *    a register that silently skips everything cannot report success.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  copyFileSync,
  readdirSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const REGISTRY = 'scripts/guard-register.json'
const backups = new Map() // file -> backup path
let restored = false

function backup(file) {
  if (backups.has(file)) return
  const dir = mkdtempSync(join(tmpdir(), 'guardreg-'))
  const to = join(dir, basename(file))
  copyFileSync(file, to)
  backups.set(file, to)
}

function restoreAll() {
  if (restored) return
  restored = true
  for (const [file, from] of backups) {
    copyFileSync(from, file)
    if (readFileSync(file).compare(readFileSync(from)) !== 0) {
      console.error(`guard-register: FATAL — ${file} did not restore byte-identically.`)
      console.error(`  A copy of the original is at ${from}. Restore it by hand before committing.`)
      process.exit(9)
    }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreAll()
    process.exit(130)
  })
}

/**
 * Run one test file filtered to one test name.
 *
 * Returns whether it passed AND whether it actually ran anything, because `vitest`
 * exits 0 when a `-t` filter matches NOTHING. Without the second value, a registry
 * entry naming a test that does not exist looks exactly like a guard that cannot
 * fail, and the runner reports the wrong defect with total confidence. Found by
 * testing this runner in its own failing direction.
 */
function runTest(file, name) {
  // A UNIQUE report path per call: a stale file from an earlier run would otherwise be
  // read as this run's result, which is the same "believed something I did not produce"
  // shape as the defects this register exists to catch.
  const report = join(mkdtempSync(join(tmpdir(), 'guardreg-report-')), 'report.json')
  let spawnFailed = false
  try {
    execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', file, '-t', name, '--reporter=json', `--outputFile=${report}`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // The child must not colour: irrelevant now that the result is structured, and
        // kept because a future reporter change should not be able to matter.
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      },
    )
  } catch (e) {
    // A non-zero exit is NORMAL here: it is what a failing test looks like, and a failing
    // test is exactly what a working mutation produces. Only a failure to RUN is a fault,
    // and that is distinguished below by whether a parseable report exists.
    if (e?.code === 'ENOENT' || e?.status === undefined) spawnFailed = true
  }
  return readReport(report, spawnFailed)
}

/**
 * The four faults, told apart (#124).
 *
 * The old version matched `Tests\s+(\d+)\s+failed` against the child's human output and
 * trusted the number. That conflated everything: "the test failed", "no summary was
 * printed", "the file did not load" and "the process never ran" were one branch. Two
 * defects came out of it. ANSI colour in CI made the pattern match nothing, so every
 * mutation read as "broke the file" and CI was red for fourteen commits. And a mutant
 * throwing `Error("Tests 1 failed")` during import was COUNTED AS PROOF with zero tests
 * executed, because the text appeared in the output.
 *
 * Reading structured fields removes both: a thrown string cannot occupy `numFailedTests`.
 * Each fault is named, because a message that says which of the four it was is the
 * difference between a finding and a prompt to start guessing.
 */
export function readReport(report, spawnFailed) {
  if (spawnFailed) {
    return { passed: false, executed: 0, total: 0, fault: 'the test runner could not be started' }
  }
  let raw
  try {
    raw = readFileSync(report, 'utf8')
  } catch {
    return {
      passed: false,
      executed: 0,
      total: 0,
      fault: 'the runner wrote no report, so its result is unknown',
    }
  }
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    return {
      passed: false,
      executed: 0,
      total: 0,
      fault: 'the runner wrote a report that is not JSON',
    }
  }
  const num = (k) => (typeof j?.[k] === 'number' ? j[k] : undefined)
  const passedN = num('numPassedTests')
  const failedN = num('numFailedTests')
  const total = num('numTotalTests')
  if (passedN === undefined || failedN === undefined || total === undefined) {
    return {
      passed: false,
      executed: 0,
      total: 0,
      fault: 'the report is missing numPassedTests, numFailedTests or numTotalTests',
    }
  }
  // EXECUTED, not total. `numTotalTests` counts every test in the file including those a
  // `-t` filter excluded, so it is not evidence that anything ran.
  const executed = passedN + failedN
  return { passed: failedN === 0 && executed > 0, executed, total, fault: null }
}

/**
 * Scripts that carry NO guard and so need no registry entry. Each must say why.
 * This is short, stable, and every entry is a claim someone can check. A NEW script
 * defaults to "must be registered" rather than to invisible, which is the polarity
 * the register was missing (#113).
 */
const NOT_A_GATE = {
  'scripts/cred-pattern.sh': 'sets one variable; sourced, never executed',
  'scripts/prose-pattern.sh': 'sets three variables; sourced, never executed',
  'scripts/guard-register.mjs':
    'this runner; its own failure modes are covered by src/guard-register.test.ts',
  'scripts/publish-sync.sh':
    'MOST of its judgement is delegated to a registered library (out-guard, ' +
    'staging-guard, source-guard, enumerate, layout) or to a registered gate ' +
    '(cred-scan-tree, perm-check, prose-check, credscan, command-paths), each of which ' +
    'carries registered mutations of its own, and its sequencing is run end-to-end by a ' +
    'CI job on every push (#114). This line used to state a TOTAL of 16 mutations between ' +
    'them; it was 18 by the time anyone counted, so the number is gone rather ' +
    'than restated, because nothing updates it (#121). NOT all of it: the HEAD source-count comparison ' +
    'and the node_modules ordering assertion are its own ' +
    'decisions and are unregistered (#124). An earlier version of this line claimed ' +
    '"every safety decision is delegated", which was false, and #117 was closed partly ' +
    'on the strength of it.',
}

/**
 * Gates that SHOULD be registered and are not yet. Every line is tracked debt with a
 * ticket, and the check fails for anything absent from both maps, so the gap is
 * mechanical instead of remembered.
 *
 * It is EMPTY, which is a statement about coverage and not about correctness. Every
 * gate script is now either registered or in NOT_A_GATE above, and NOT_A_GATE says for
 * each one what is still its own unregistered decision. An empty map here does not mean
 * every refusal in this repository is proven able to fail; the paragraph on the refusal
 * ratchet below is explicit about what is and is not claimed.
 *
 * The last entry was scripts/build-mcpb.sh, whose surface blocklist was the one decision
 * it made alone. It is now an allowlist over the packed archive, reachable through
 * `build-mcpb.sh --audit-archive` with a listing on stdin, so it can be handed the input
 * that makes it fire without building a bundle (#120).
 *
 * This used to say "emptying this is a release requirement". That was prose rather than
 * a risk assessment, and the first release shipped with entries outstanding for the
 * reasons on #117. Do not put that sentence back: an entry here is a tracked decision,
 * not a failure, and a marker contradicting the decision is the class #115 exists to stop.
 */
const COVERAGE_DEBT = {}

/**
 * The REFUSAL GRAMMAR, and the ratchet over it (#124).
 *
 * The register is a deny-list of the author's memory: it proves what someone remembered
 * to add. That is how `prepublish-guard.sh`'s completeness assertion went unregistered
 * while five tests passed around it. A registry cannot report what is missing from it,
 * so the denominator has to come from the code.
 *
 * WHAT THIS CLAIMS, exactly, and nothing more:
 *
 *   The number of syntactically recognised refusal sites in each gate script is the
 *   number recorded below, and a change to any of them fails this check.
 *
 * It does NOT claim every guard is inventoried, and it does not claim the existing sites
 * are covered. Two reasons, both measured rather than assumed:
 *
 *   - A refusal can be expressed outside this grammar. A helper that exits internally
 *     looks like an ordinary call at its call site, and no syntactic rule there can prove
 *     otherwise. The grammar is kept honest from the other end instead: idiom-check
 *     forbids the non-literal forms, so a new refusal must use a recognised one.
 *   - Mapping a site to a registry ENTRY is not reliably computable. An entry's anchor is
 *     usually the CONDITION; the refusal sits a line or two later inside the block. A
 *     first attempt at a coverage fraction reported "prose-check: 0 of 13 accounted" for
 *     a guard that is registered and proven able to fail. A number that wrong is worse
 *     than no number, so there is no coverage fraction here. Burning the gap down is
 *     tracked separately.
 *
 * What it DOES buy: a refusal site cannot be added silently. The existing 149 are
 * grandfathered, and the next one has to be accounted for, which is where a new
 * unguarded guard would otherwise come from.
 */
// Written with character classes where a literal would match ITSELF. `return 1\b` as
// source text contains "return 1", so the pattern counted its own definition and this
// file read as 4 refusal sites instead of 3. `return[ ]1\b` matches the same input while
// its source text does not. Third time this week that documenting a convention tripped
// the check enforcing it, and the first where the fix was to change the notation rather
// than to exempt a line.
const REFUSAL_GRAMMAR =
  /(?:^|[^A-Za-z_])(exit [0-9]+|process\.exit\(|return[ ]1\b|fail[=]1\b|HARD_FAIL[=]1\b|throw[ ]new )/

/**
 * Refusal sites per gate script, as counted by REFUSAL_GRAMMAR. Updating a number here is
 * a deliberate act: it means "I added or removed a refusal, and I have decided whether it
 * needs a registry entry". Do not update one to make this pass without answering that.
 */
const REFUSAL_BASELINE = {
  // 20 -> 23 when #140 added the bundle README's link rewrite. Three sites, all one
  // guard: `process.exit(1)` inside the rewrite heredoc when a relative link survives,
  // the `exit 1` that refuses the build, and the `staging_wipe || exit 1` beside it.
  // DECLARED UNPINNED at that line and not registered: the check is a postcondition over
  // the script's own rewrite, so no caller-supplied input can make it fire and there is
  // nothing for a test to feed it. Verified by running it: 13 links rewritten, 0
  // remaining. Counted with refusalSites, not by eye.
  //
  // 14 -> 20 when #120 replaced the staged-surface name blocklist with an allowlist over
  // the PACKED ARCHIVE. Six sites, counted with refusalSites below rather than by eye:
  // the allowlist's own refusal, and five in the `--audit-archive` entry point that lets
  // a test drive that decision with a synthetic listing. Two further fail-closed sites
  // in the same function are `return 2`, which this grammar does not recognise; it sees
  // `return 1` and not other return values.
  'scripts/build-mcpb.sh': 23,
  'scripts/command-paths.mjs': 1,
  'scripts/cred-scan-tree.sh': 7,
  'scripts/credscan.sh': 6,
  'scripts/docs-links.mjs': 2,
  'scripts/enumerate.sh': 3,
  'scripts/guard-register.mjs': 3,
  'scripts/idiom-check.sh': 8,
  'scripts/layout.mjs': 2,
  'scripts/layout.sh': 2,
  'scripts/out-guard.sh': 7,
  'scripts/perm-check.sh': 11,
  'scripts/prepublish-guard.sh': 12,
  // 13 -> 14 when the OVERCLAIM pattern was added: published prose claimed routing of
  // every ACTION while the code routes every WRITE and lets reads use the selected
  // default. One site, the `fail=1` beside the new scan. Registered below, because this
  // one CAN be driven by input: a doc containing the sentence is exactly what makes it
  // fire, which is the property the build-mcpb note above had to declare unpinned.
  'scripts/prose-check.sh': 14,
  // 37 -> 38 when #121 added audit gate (E), which runs command-paths.mjs against the
  // STAGED tree so a --no-verify assembly is covered too. Not separately registered:
  // the decision belongs to command-paths.mjs, which carries its own mutation, and
  // gate (E) is the delegation. First real use of this ratchet, and it caught the new
  // site on the day it appeared.
  // 38 -> 37 when #125 moved the internal-reference scan out to scripts/ref-scan.sh.
  // Three sites left with it (ref_exempt's `return 1` and the two HARD_FAIL=1 arms of
  // the inline filter) and two came back as the three-status handling of the new
  // script's exit code. The decision went with the code, and it is registered there.
  'scripts/publish-sync.sh': 37,
  'scripts/ref-scan.sh': 13,
  'scripts/source-guard.sh': 5,
  'scripts/version-check.mjs': 3,
  'scripts/staging-guard.sh': 17,
}

/** Count refusal sites in one file, ignoring comment lines. */
export function refusalSites(source) {
  return source
    .split('\n')
    .filter((l) => REFUSAL_GRAMMAR.test(l) && !/^\s*(#|\/\/|\*|\/\*)/.test(l)).length
}

/**
 * The comparison, as a PURE function so it can be driven directly.
 *
 * It was first written inline inside the enumerating function, and registered with a
 * mutation that disabled the comparison. The register then reported THE GUARD CANNOT FAIL:
 * the named test exercised the COUNTER and never reached the comparison, so the proof was
 * vacuous. That is the defect this whole ticket is about, committed while fixing it.
 *
 * Takes both sides as arguments, returns the messages. No filesystem, no globals.
 */
export function refusalMismatches(baseline, counts, requireAllPresent = true) {
  const out = []
  for (const [file, actual] of Object.entries(counts)) {
    const expected = baseline[file]
    if (expected === undefined) {
      if (actual > 0) {
        out.push(
          `${file} has ${actual} refusal site(s) and no recorded baseline. A new gate ` +
            `script must record its count, and decide which of those sites need a ` +
            `registry entry.`,
        )
      }
      continue
    }
    if (actual !== expected) {
      const verb = actual > expected ? 'GAINED' : 'LOST'
      out.push(
        `${file} ${verb} refusal site(s): ${expected} recorded, ${actual} found. If you ` +
          `added a guard, register it and then update the baseline. If you removed one, ` +
          `check no registry entry still names it. Do not just change the number.`,
      )
    }
  }
  // A baseline entry with no file is a finding in the DEVELOPMENT tree and expected in
  // the assembled PUBLIC one, where scripts the allowlist denies are absent by design.
  // publish-sync.sh is the case that found this: it is in DENY_PATHS, so the public
  // tree's own `npm run verify` reported it as a vanished entry and failed. The ratchet
  // broke the tree it was meant to protect, on the first assembly after it landed.
  if (requireAllPresent) {
    for (const file of Object.keys(baseline)) {
      if (!(file in counts)) {
        out.push(`${file} has a recorded baseline but no longer exists; remove its entry.`)
      }
    }
  }
  // A ratchet with nothing to count is satisfied by deleting its own input.
  if (Object.keys(counts).length === 0) {
    out.push('no gate scripts were found at all, which is not a pass.')
  }
  return out
}

/** The ratchet: count every gate script, then compare. */
function refusalFailures() {
  // The baseline describes THIS repository, so it only applies in a tree that is this
  // repository. The register's own self-tests build a throwaway tree holding one script,
  // where every baseline entry would read as "no longer exists" and drown the result.
  // `.manyportals-layout` is how this project already identifies its own trees (#107), so
  // it is reused rather than sniffing for something new. Said OUT LOUD when skipped: a
  // check that goes quiet is one nobody notices has stopped running.
  if (!existsSync('.manyportals-layout')) {
    console.log(
      'guard-register: refusal ratchet SKIPPED (no .manyportals-layout, so not this repo).',
    )
    return []
  }
  const counts = {}
  for (const name of readdirSync('scripts').sort()) {
    if (!/\.(sh|mjs)$/.test(name)) continue
    counts[`scripts/${name}`] = refusalSites(readFileSync(`scripts/${name}`, 'utf8'))
  }
  // Only the development tree holds every gate script. In the assembled public tree the
  // denied ones are absent on purpose, so their absence is not a finding there; the
  // counts of those that ARE present still ratchet normally.
  // NOT through mpLayout, and that is a deliberate, uncomfortable choice (#127).
  // Importing layout.mjs here breaks this file's OWN fixtures in two ways: the
  // throwaway tree copies guard-register.mjs alone, so the import is
  // ERR_MODULE_NOT_FOUND, and once copied, layout.mjs is a gate script present in
  // scripts/ with no entry in the fixture's registry, so the coverage floor correctly
  // refuses. Accommodating that means weakening the floor or giving every fixture a
  // real layout mutation, neither of which is worth a tidier read.
  // So this stays a private copy, and the risk is stated rather than hidden: it agrees
  // with layout.mjs by coincidence, not by construction. `.trim()` here follows
  // Unicode whitespace exactly as layout.mjs's old `.trim()` did, so a BOM or a
  // non-breaking space is accepted HERE and refused by both declared readers. The
  // consequence is bounded: the value only chooses whether an absent gate script is a
  // finding, and a marker the readers refuse fails the run long before this line
  // matters. Tracked on #127.
  const layout = readFileSync('.manyportals-layout', 'utf8').trim()
  return refusalMismatches(REFUSAL_BASELINE, counts, layout === 'dev')
}

/** Every gate script must be registered, exempted, or listed as tracked debt. */
function coverageFailures(entries) {
  const registered = new Set(entries.map((e) => e.file))
  const out = []
  for (const name of readdirSync('scripts').sort()) {
    if (!/\.(sh|mjs)$/.test(name)) continue
    const file = `scripts/${name}`
    if (registered.has(file) || file in NOT_A_GATE || file in COVERAGE_DEBT) continue
    out.push(
      `${file} has no registry entry, is not listed as a non-gate, and is not tracked ` +
        `debt. Register a guard in it, or say in NOT_A_GATE why it carries none.`,
    )
  }
  return out
}

function main() {
  // POSIX only, said OUT LOUD rather than skipped quietly, which is the same choice
  // perm-check.sh makes for the same reason. The register mutates source files,
  // spawns a nested vitest and restores from a byte-for-byte copy; that machinery is
  // maintainer tooling and its behaviour is verified on four other legs of this
  // matrix. Three separate Windows-specific repairs did not make the fixture behave,
  // and a fourth blind attempt is not a better use of the gate than an honest
  // statement of what it does not cover. Tracked on #96.
  if (process.platform === 'win32') {
    console.log('guard-register: SKIPPED on Windows — POSIX maintainer tooling (#96).')
    console.log('                The mutations are proven on the Linux and macOS legs.')
    return
  }
  const entries = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  // No layout detection here. This used to compute one from `existsSync('public')` and
  // then use it in two message strings and nowhere else, so the sniff was removed rather
  // than repaired (#107): whether an entry's file is present is already decided below by
  // asking the filesystem for that exact file, which is the question that matters.
  let exercised = 0
  let skipped = 0
  const failures = [...coverageFailures(entries), ...refusalFailures()]

  for (const e of entries) {
    if (!existsSync(e.file)) {
      if (e.devOnly) {
        skipped++
        console.log(`  --  ${e.id} (dev-only, ${e.file} is not in this tree)`)
        continue
      }
      failures.push(`${e.id}: ${e.file} does not exist, and the entry is not dev-only`)
      continue
    }
    const before = readFileSync(e.file, 'utf8')
    const hits = before.split(e.find).length - 1
    if (hits !== 1) {
      // The guard moved or was removed. That is the finding, not a reason to skip.
      failures.push(
        `${e.id}: its anchor matches ${hits} times in ${e.file}, expected exactly 1. ` +
          `The guard was probably changed or removed; update the registry deliberately.`,
      )
      continue
    }
    // `expect` is passed to vitest's `-t`, which is a REGEX. A name containing `(#124)`
    // makes the parens a capture group and matches NOTHING, so the entry would report
    // "executed NO test" — a true statement about a false cause, and the author would go
    // looking for a missing test that is right there. The register fails closed either
    // way; this turns a confusing failure into an accurate one. Checked, not assumed:
    // none of the current entries contain a metacharacter.
    const meta = /[()[\]{}*+?^$|\\]/.exec(e.expect)
    if (meta !== null) {
      failures.push(
        `${e.id}: its \`expect\` contains ${JSON.stringify(meta[0])}, and \`expect\` is used ` +
          `as a vitest -t REGEX, so it would match no test. Use a paren-free substring of ` +
          `the test name.`,
      )
      continue
    }
    const baseline = runTest(e.test, e.expect)
    if (baseline.fault !== null) {
      failures.push(`${e.id}: BEFORE any mutation, ${baseline.fault} (${e.test}).`)
      continue
    }
    if (baseline.executed === 0) {
      failures.push(
        `${e.id}: "${e.expect}" executed NO test in ${e.test} (the file holds ` +
          `${baseline.total}). vitest exits 0 on a filter that matches nothing, so this ` +
          `would otherwise be reported as a guard that cannot fail, which is the wrong ` +
          `defect.`,
      )
      continue
    }
    if (!baseline.passed) {
      failures.push(`${e.id}: "${e.expect}" fails in ${e.test} BEFORE any mutation.`)
      continue
    }
    backup(e.file)
    writeFileSync(e.file, before.split(e.find).join(e.replace))
    const mutated = runTest(e.test, e.expect)
    writeFileSync(e.file, before)
    if (mutated.fault !== null) {
      failures.push(`${e.id}: with the mutation applied, ${mutated.fault} (${e.test}).`)
      continue
    }
    if (mutated.executed === 0) {
      // A mutation that breaks parsing or imports stops the test EXECUTING, and that
      // proves nothing. It used to be folded into `survived = passed && ran`, so such a
      // mutant scored as proof (#113). It then survived a second time: a mutant throwing
      // `Error("Tests 1 failed")` during import put that text in the output, the regex
      // matched it, and the runner counted a proof with zero tests run (#124). A number
      // read from `numFailedTests` cannot be forged by a thrown string.
      failures.push(
        `${e.id}: the mutation stopped "${e.expect}" from EXECUTING (the file holds ` +
          `${mutated.total} test(s)), so it proves nothing about the guard. Choose a ` +
          `mutation that changes BEHAVIOUR rather than one that breaks the file.`,
      )
      continue
    }
    const survived = mutated.passed
    if (survived) {
      failures.push(
        `${e.id}: THE GUARD CANNOT FAIL. With it removed, "${e.expect}" still passes. ${e.why}`,
      )
    } else {
      exercised++
      console.log(`  ok  ${e.id}`)
    }
  }

  restoreAll()

  // The floor was `entries.filter(e => !e.devOnly).length`, derived from the registry
  // itself, so an EMPTY registry required zero and passed. A check must not be
  // satisfiable by deleting its own input (#113).
  if (entries.length === 0) {
    failures.push(
      'the registry is empty. A register with nothing in it is not a register, and this ' +
        'check must not be satisfiable by removing its own input.',
    )
  }
  const present = entries.filter((e) => existsSync(e.file))
  // A run that proves NOTHING is not a pass, whatever the registry holds (#130).
  //
  // The check below compares exercised against the entries whose file is present, and an
  // entry whose file is absent is skipped rather than counted. So a registry holding only
  // dev-only entries with absent files satisfied `0 < 0` and exited 0 reporting
  // "0 guard(s) proven able to fail". The adjacent hole — an EMPTY registry — was already
  // refused above, and that is exactly why this one survived: the two read identically in
  // a summary and differ in the predicate. One tests the registry's length, this one has
  // to test the exercised count.
  //
  // This deliberately refuses a tree in which EVERY entry is dev-only, including a public
  // one. A tree that verifies nothing is not verified, and reporting success for it is the
  // certification problem this whole file exists to prevent.
  if (exercised === 0 && failures.length === 0) {
    failures.push(
      `zero guards were exercised, out of ${entries.length} registry entr(y/ies). A run ` +
        `that proves nothing is not a pass.`,
    )
  } else if (exercised < present.length && failures.length === 0) {
    failures.push(
      `only ${exercised} of ${present.length} entries whose file is present were ` +
        `exercised. A register that skips its way to success is not a register.`,
    )
  }
  if (failures.length > 0) {
    console.error('\nguard-register: FAILED')
    for (const f of failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  const debt = Object.keys(COVERAGE_DEBT).length
  if (debt > 0) {
    console.log(`guard-register: ${debt} gate script(s) still unregistered:`)
    for (const [f, why] of Object.entries(COVERAGE_DEBT)) console.log(`      ${f}  (${why})`)
  }
  console.log(
    `guard-register: ${exercised} guard(s) proven able to fail` +
      (skipped ? `, ${skipped} dev-only skipped, their files not being in this tree` : ''),
  )
}

// Only when RUN, not when imported. countedTests is exported so it can be tested
// directly, and importing this file used to execute every mutation as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } finally {
    restoreAll()
  }
}
