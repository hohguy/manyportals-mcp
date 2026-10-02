import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The register's own failure modes (#113).
 *
 * It exists to prove other guards can fail, so a register that cannot itself fail is
 * worse than none: it certifies. Two of these were real defects found by review.
 * A mutation that breaks PARSING stops the test executing, and `!ran` was folded into
 * "the guard killed it", so a mutant that ran nothing scored as proof. And the floor
 * was derived from the registry, so an EMPTY registry required zero entries and passed.
 */
const REPO = process.cwd()

// Each case spawns the runner, which spawns vitest, which spawns another vitest. Under
// the full suite that contends with every other file and overruns the 5s default; alone
// it does not, which is exactly the kind of "passed in one context" result this session
// keeps finding. Generous and explicit rather than incidental.
const SPAWNS_VITEST = 120_000

/** A throwaway project with its own scripts/, source and registry. */
function fixture(entries: unknown[], extraScripts: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), 'guardreg-'))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  mkdirSync(join(d, 'src'), { recursive: true })
  copyFileSync(join(REPO, 'scripts/guard-register.mjs'), join(d, 'scripts/guard-register.mjs'))
  for (const f of ['vitest.config.ts', 'package.json', 'tsconfig.json']) {
    copyFileSync(join(REPO, f), join(d, f))
  }
  symlinkSync(join(REPO, 'node_modules'), join(d, 'node_modules'))
  writeFileSync(
    join(d, 'src/thing.ts'),
    'export const guard = (n: number): boolean => n > 0\nexport const helper = (): number => 42\n',
  )
  writeFileSync(
    join(d, 'src/thing.test.ts'),
    `import { describe, it, expect } from 'vitest'
import { guard } from './thing.js'
describe('thing', () => {
  it('the guard rejects a negative', () => {
    expect(guard(-1)).toBe(false)
  })
})
`,
  )
  for (const name of extraScripts) writeFileSync(join(d, 'scripts', name), '#!/usr/bin/env bash\n')
  writeFileSync(join(d, 'scripts/guard-register.json'), JSON.stringify(entries, null, 2))
  return d
}

function run(dir: string): { rc: number; out: string } {
  try {
    const out = execFileSync('node', ['scripts/guard-register.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { rc: 0, out }
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string }
    return {
      rc: typeof x.status === 'number' ? x.status : -1,
      out: (x.stdout ?? '') + (x.stderr ?? ''),
    }
  }
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e',
  why: 'the guard rejects a negative',
  file: 'src/thing.ts',
  find: 'n > 0',
  replace: 'true',
  test: 'src/thing.test.ts',
  expect: 'the guard rejects a negative',
  devOnly: false,
  ...over,
})

/**
 * POSIX only. These cases build a fixture repo, symlink node_modules into it and run
 * the register there. On Windows the fixture runs but the mutation does not take, and
 * three targeted repairs did not change that. The register itself now skips on
 * Windows and says so, so this suite matches it. The parser cases below are pure and
 * run everywhere. Tracked on #96.
 */
describe.skipIf(process.platform === 'win32')(
  'guard-register proves guards, and can itself fail',
  () => {
    /**
     * #130. The register's own certification problem, one level down.
     *
     * The floor compared `exercised` against the entries whose FILE IS PRESENT, and an
     * entry whose file is absent is skipped rather than counted. A registry holding only
     * dev-only absent entries therefore satisfied `0 < 0` and exited 0 reporting
     * "0 guard(s) proven able to fail". The empty-registry refusal, which landed for the
     * adjacent hole, is exactly why this one survived: the two read identically in a
     * summary and differ in the predicate.
     */
    it(
      'a registry of only skipped entries proves nothing and fails',
      () => {
        const r = run(fixture([entry({ file: 'scripts/absent.sh', devOnly: true })]))
        expect(r.rc, `guard-register said:\n${r.out}`).toBe(1)
        expect(r.out).toContain('zero guards were exercised')
      },
      SPAWNS_VITEST,
    )

    // The row an over-strict floor breaks. Skipping a dev-only entry whose file is not in
    // this tree is CORRECT, and it is what the assembled public tree does on every build.
    it(
      'still passes when some entries are skipped and at least one is exercised',
      () => {
        const r = run(
          fixture([entry(), entry({ id: 'skipped', file: 'scripts/absent.sh', devOnly: true })]),
        )
        expect(r.rc, `guard-register said:\n${r.out}`).toBe(0)
        expect(r.out).toContain('1 guard(s) proven able to fail')
        expect(r.out).toContain('1 dev-only skipped')
      },
      SPAWNS_VITEST,
    )

    it(
      'an honest behavioural mutation counts as proof',
      () => {
        const r = run(fixture([entry()]))
        expect(r.rc, `guard-register said:\n${r.out}`).toBe(0)
        expect(r.out).toContain('1 guard(s) proven able to fail')
      },
      SPAWNS_VITEST,
    )

    it(
      'a mutation that stops the test RUNNING proves nothing',
      () => {
        // Breaking the parse means zero tests execute. That used to be credited.
        const r = run(
          fixture([
            entry({
              find: 'export const helper = (): number => 42',
              replace: 'export const helper = (: number => 42',
            }),
          ]),
        )
        expect(r.rc).toBe(1)
        expect(r.out).toContain('from EXECUTING')
      },
      SPAWNS_VITEST,
    )

    it(
      'an empty registry fails rather than passing vacuously',
      () => {
        const r = run(fixture([]))
        expect(r.rc).toBe(1)
        expect(r.out).toContain('registry is empty')
      },
      SPAWNS_VITEST,
    )

    it(
      'a stale anchor fails, which is how a removed guard announces itself',
      () => {
        const r = run(fixture([entry({ find: 'a string that is not in the file' })]))
        expect(r.rc).toBe(1)
        expect(r.out).toContain('expected exactly 1')
      },
      SPAWNS_VITEST,
    )

    it(
      'a test name that matches nothing is reported as such, not as a dead guard',
      () => {
        const r = run(fixture([entry({ expect: 'a test name nobody wrote' })]))
        expect(r.rc).toBe(1)
        expect(r.out).toContain('executed NO test')
      },
      SPAWNS_VITEST,
    )

    it(
      'a new gate script with no entry and no exemption fails the coverage floor',
      () => {
        // The polarity that was missing: a script nobody registered was invisible.
        const r = run(fixture([entry()], ['brand-new-gate.sh']))
        expect(r.rc).toBe(1)
        expect(r.out).toContain('brand-new-gate.sh')
        expect(r.out).toContain('no registry entry')
      },
      SPAWNS_VITEST,
    )
  },
)

/**
 * The register no longer PARSES the child's output, so the tests that pinned that parse
 * are gone with it. They pinned the wrong thing twice over: first the regex could not
 * survive ANSI colour, and then a mutant throwing `Error("Tests 1 failed")` during import
 * put summary-shaped text where the parser would find it and was counted as proof with
 * zero tests executed (#124).
 *
 * A number read from `numFailedTests` in a structured report cannot be forged by a thrown
 * string, which is why the replacement below drives the FAULTS rather than the parse.
 */
describe('a mutant cannot forge a result (#124)', () => {
  it(
    'refuses a mutant that throws text shaped like a summary during import',
    () => {
      // The reviewer's exact counterexample. Syntactically valid, so it is not a "broke
      // the file" mutation; it throws on import, so nothing executes; and the message
      // is what the old parser was looking for.
      const d = fixture([entry({ replace: 'true\nthrow new Error("Tests 1 failed")' })])
      const r = run(d)
      expect(r.rc, `guard-register said:\n${r.out}`).toBe(1)
      expect(r.out).toContain('from EXECUTING')
      expect(r.out).not.toContain('proven able to fail')
    },
    SPAWNS_VITEST,
  )
})

/**
 * The FOUR faults, driven directly (#124).
 *
 * They are distinct branches because collapsing them is how the original defect arose:
 * "the test failed", "no summary was printed", "the file did not load" and "the process
 * never ran" were one condition, and a mutant that stopped the test executing scored as
 * proof. Each must fail the register with a message saying which of the four it was.
 *
 * `readReport` is pure given a path, so these are driven without spawning vitest. The
 * missing and malformed cases cannot be produced from outside the runner at all, which is
 * exactly why they went untested until a reviewer asked.
 */
describe('readReport distinguishes the four faults', () => {
  const read = (arg: string, spawnFailed = false): { fault: string | null; executed: number } => {
    const out = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { readReport } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', 'guard-register.mjs')).href)}
         process.stdout.write(JSON.stringify(readReport(process.argv[1], process.argv[2] === 'true')))`,
        arg,
        String(spawnFailed),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return JSON.parse(out) as { fault: string | null; executed: number }
  }

  const reportFile = (contents: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'report-'))
    const p = join(d, 'report.json')
    writeFileSync(p, contents)
    return p
  }

  it('1. the child could not be started', () => {
    const r = read(reportFile('{}'), true)
    expect(r.fault).toMatch(/could not be started/)
  })

  it('2. no report was written', () => {
    const r = read(join(tmpdir(), 'no-such-report-at-all.json'))
    expect(r.fault).toMatch(/wrote no report/)
  })

  it('3. the report is not JSON', () => {
    const r = read(reportFile('this is not json'))
    expect(r.fault).toMatch(/not JSON/)
  })

  it('3b. the report is JSON but missing the counts', () => {
    const r = read(reportFile(JSON.stringify({ success: true })))
    expect(r.fault).toMatch(/missing numPassedTests/)
  })

  it('4. zero tests executed is NOT a fault, it is a zero count', () => {
    // Deliberately distinct: "nothing ran" is a valid reading of a valid report, and the
    // caller decides what it means. Conflating it with a fault would lose the total,
    // which is what tells you whether the file loaded at all.
    const r = read(
      reportFile(JSON.stringify({ numPassedTests: 0, numFailedTests: 0, numTotalTests: 7 })),
    )
    expect(r.fault).toBeNull()
    expect(r.executed).toBe(0)
  })

  it('counts EXECUTED tests, not the total in the file', () => {
    // numTotalTests includes tests a -t filter excluded, so it is not evidence anything ran.
    const r = read(
      reportFile(JSON.stringify({ numPassedTests: 2, numFailedTests: 1, numTotalTests: 90 })),
    )
    expect(r.fault).toBeNull()
    expect(r.executed).toBe(3)
  })
})

/**
 * The refusal inventory, and the honest limits of what it claims (#124).
 *
 * The register is a deny-list of the author's memory: it proves what someone remembered
 * to add, which is how `prepublish-guard.sh`'s completeness assertion went unregistered
 * while five tests passed around it. A registry cannot report what is missing from it, so
 * the denominator comes from the code.
 *
 * ONE INSTANCE OF EVERY SUPPORTED FORM is pinned below. An inventory nobody has watched
 * find something is the same defect one level up, which is this ticket's whole subject.
 */
describe('the refusal inventory finds every form it claims to (#124)', () => {
  const count = (source: string): number => {
    const out = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { refusalSites } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', 'guard-register.mjs')).href)}
         process.stdout.write(String(refusalSites(process.argv[1])))`,
        source,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return Number(out)
  }

  it.each([
    ['exit with a literal status', 'if [ -z "$x" ]; then exit 1; fi'],
    ['exit with a non-1 status', '  exit 2'],
    ['a shell function returning 1', 'f() { [ -n "$1" ] || return 1; }'],
    ['a fail flag', '  fail=1'],
    ['a hard-fail flag', '  HARD_FAIL=1'],
    ['a thrown error', '  throw new Error("nope")'],
    ['process.exit', '  process.exit(1)'],
  ])('finds %s', (_label, line) => {
    expect(count(line + '\n')).toBe(1)
  })

  it('ignores a COMMENT that merely mentions a form', () => {
    // These scripts discuss their own refusals by name. A counter its own documentation
    // inflates is a counter nobody will keep accurate.
    expect(count('# exit 1 would be wrong here\n// throw new Error()\n * fail=1\n')).toBe(0)
  })

  it('does not match its own definition', () => {
    // `return 1\b` as SOURCE TEXT contains "return 1", so an earlier version counted the
    // line defining the grammar and this file read as 4 sites instead of 3. The pattern
    // uses character classes now, so its own source is not an instance of it.
    const self = readFileSync(join(REPO, 'scripts', 'guard-register.mjs'), 'utf8')
    const grammarLine = self.split('\n').find((l) => l.includes('const REFUSAL_GRAMMAR')) ?? ''
    const next = self.split('\n')[self.split('\n').indexOf(grammarLine) + 1] ?? ''
    expect(count(next + '\n')).toBe(0)
  })

  it('counts nothing in an empty file, rather than failing open', () => {
    expect(count('')).toBe(0)
    expect(count('echo hello\n')).toBe(0)
  })
})

/**
 * The ratchet's COMPARISON, driven directly.
 *
 * It was first written inline, and registered with a mutation that disabled the comparison
 * while the named test only exercised the counter. The register reported THE GUARD CANNOT
 * FAIL, which was correct: the proof was vacuous. Extracting the comparison is what makes
 * it provable, and that is the whole lesson of this ticket committed against itself.
 */
describe('the refusal ratchet detects change (#124)', () => {
  const mismatches = (baseline: unknown, counts: unknown, requireAll = true): string[] => {
    const out = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { refusalMismatches } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', 'guard-register.mjs')).href)}
         process.stdout.write(JSON.stringify(refusalMismatches(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), process.argv[3] === 'true')))`,
        JSON.stringify(baseline),
        JSON.stringify(counts),
        String(requireAll),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return JSON.parse(out) as string[]
  }

  it('is silent when every count matches', () => {
    expect(mismatches({ 'scripts/a.sh': 3 }, { 'scripts/a.sh': 3 })).toEqual([])
  })

  it('reports a GAINED refusal site', () => {
    const r = mismatches({ 'scripts/a.sh': 3 }, { 'scripts/a.sh': 4 })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain('GAINED')
  })

  it('reports a LOST refusal site', () => {
    const r = mismatches({ 'scripts/a.sh': 3 }, { 'scripts/a.sh': 2 })
    expect(r[0]).toContain('LOST')
  })

  it('reports a new gate script with no recorded baseline', () => {
    const r = mismatches({}, { 'scripts/new.sh': 2 })
    expect(r[0]).toContain('no recorded baseline')
  })

  it('reports a baseline entry whose file is gone, in the DEV tree', () => {
    const r = mismatches({ 'scripts/gone.sh': 1 }, {})
    // Two findings: the empty set, and the vanished file. Both are real.
    expect(r.join(' ')).toContain('no longer exists')
  })

  it('does NOT report an absent file in the assembled PUBLIC tree', () => {
    // The public tree lacks every script the allowlist denies, publish-sync.sh among
    // them, so their absence is expected there rather than a finding. This case exists
    // because the ratchet broke the public tree's own verify on the first assembly after
    // it landed: it reported publish-sync.sh as a vanished baseline entry.
    const r = mismatches(
      { 'scripts/a.sh': 2, 'scripts/denied.sh': 1 },
      { 'scripts/a.sh': 2 },
      false,
    )
    expect(r).toEqual([])
  })

  it('still ratchets the files that ARE present in a public tree', () => {
    // The relaxation must apply only to absence, not to the counts.
    const r = mismatches(
      { 'scripts/a.sh': 2, 'scripts/denied.sh': 1 },
      { 'scripts/a.sh': 3 },
      false,
    )
    expect(r).toHaveLength(1)
    expect(r[0]).toContain('GAINED')
  })

  it('refuses an empty count set, so deleting its own input is not a pass', () => {
    expect(mismatches({}, {}).join(' ')).toContain('not a pass')
  })
})
