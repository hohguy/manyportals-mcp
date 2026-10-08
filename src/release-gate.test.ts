import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The release gate (#162).
 *
 * #116 carried `wave:publish-gate`, meaning "decide before publishing". The repo went
 * public at v0.1.8 with it unresolved and nothing noticed, because nothing read the
 * label. These drive the gate through `RELEASE_GATE_CMD`, which replaces `gh`, so every
 * branch can be given its input without touching the network.
 *
 * The cases that matter most are the ones where the gate CANNOT LOOK: a failed query, a
 * missing label, an unreadable run, a cancelled leg. Every one must refuse. A gate that
 * reports clean when it could not see is the defect this whole file exists to prevent, and
 * it has been written by accident twice in this repository already (#108, #109).
 *
 * The second describe block covers the cross-platform clause (#212), where the same defect
 * has one more disguise: `cancelled` is not a failure, and reading "nothing said failure"
 * as "passed" would accept a run that produced no evidence at all.
 */
const REPO = process.cwd()
const LAYOUT = readFileSync(join(REPO, '.manyportals-layout'), 'utf8').trim()

/**
 * A stand-in for `gh`: answers `label list`, `issue list`, `run list` and `run view` from
 * fixed text, and LOGS its own argv so a test can assert what was asked.
 *
 * The run answers default to green, so the cases written before the cross-platform clause
 * existed (#212) still exercise what they were written for rather than stopping at a new
 * refusal on their way.
 */
/**
 * RAW `gh run view --json jobs` output, because the projection that selects the
 * cross-platform legs now lives in the script and this is its input (#298).
 *
 * It used to be already-formatted lines, and the stub ignored `--jq` — so replacing the
 * production selector with one matching NO JOBS left all 29 cases green. The fake answered
 * downstream of the step that was broken, which is this project's own rule about a fake not
 * exceeding production robustness, sitting inside the clause that decides whether a release
 * has cross-platform evidence.
 *
 * `conclusion: null` is how GitHub reports an in-flight job, and `undefined` here omits the
 * key entirely, which is a different shape worth carrying.
 */
const legs = (
  rows: Array<[conclusion: string | null | undefined, name: string]>,
  extra: Array<[string, string]> = [['success', 'verify (ubuntu-24.04, 24)']],
): string =>
  JSON.stringify({
    jobs: [
      ...rows.map(([conclusion, name]) =>
        conclusion === undefined ? { name } : { name, conclusion },
      ),
      // A non-cross-platform job is always present in a real run, so every case also proves
      // the selector still SELECTS rather than taking whatever came back.
      ...extra.map(([conclusion, name]) => ({ name, conclusion })),
    ],
  })

const GREEN_LEGS = legs([
  ['success', 'cross-platform (windows-latest, 24)'],
  ['success', 'cross-platform (macos-latest, 24)'],
  ['success', 'cross-platform (ubuntu-26.04, 24)'],
])

/** A package.json holding just a version, for the artifact-binding check (#296). */
function pkgFixture(version: string): string {
  const d = mkdtempSync(join(tmpdir(), 'mp-pkg-'))
  const p = join(d, 'package.json')
  writeFileSync(p, JSON.stringify({ version }))
  return p
}

function stubGh(opts: {
  labels?: string
  issues?: string
  runs?: string
  jobs?: string
  // `gh api .../dependencies/blocked_by`, one "<number> <state> <wave label>" per line.
  // Defaults to EMPTY, so every case written before the cross-wave clause (#239) still
  // exercises what it was written for instead of stopping at a new refusal.
  blockedBy?: string
  failOn?: 'label' | 'issue' | 'runs' | 'jobs' | 'deps'
}): string {
  const d = mkdtempSync(join(tmpdir(), 'mp-gate-'))
  const p = join(d, 'gh')
  writeFileSync(
    p,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$(dirname "$0")/argv.log"
case "$1 $2" in
  "label list")
    ${opts.failOn === 'label' ? 'echo "gh: HTTP 401" >&2; exit 1' : `printf '%b' ${JSON.stringify(opts.labels ?? '')}`}
    ;;
  "issue list")
    ${opts.failOn === 'issue' ? 'echo "gh: HTTP 500" >&2; exit 1' : `printf '%b' ${JSON.stringify(opts.issues ?? '')}`}
    ;;
  "run list")
    ${opts.failOn === 'runs' ? 'echo "gh: HTTP 502" >&2; exit 1' : `printf '%b' ${JSON.stringify(opts.runs ?? '101\n')}`}
    ;;
  "run view")
    ${opts.failOn === 'jobs' ? 'echo "gh: HTTP 403" >&2; exit 1' : `printf '%b' ${JSON.stringify(opts.jobs ?? GREEN_LEGS)}`}
    ;;
  "api "*)
    ${opts.failOn === 'deps' ? 'echo "gh: HTTP 410" >&2; exit 1' : `printf '%b' ${JSON.stringify(opts.blockedBy ?? '')}`}
    ;;
  *) echo "stub: unexpected $*" >&2; exit 99 ;;
esac
`,
  )
  chmodSync(p, 0o755)
  return p
}

/** Everything the stub was asked, one invocation per line. */
function askedOf(stub: string): string {
  return readFileSync(join(dirname(stub), 'argv.log'), 'utf8')
}

function gate(stub: string, args: string[], pkgVersion?: string): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/release-gate.sh', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_GATE_CMD: stub,
        RELEASE_GATE_REPO: 'example/repo',
        // The version these cases ask about, supplied rather than inherited from the real
        // package.json (#296). The gate now refuses a version that does not belong to the
        // artifact it queries, and pinning the fixture here is what keeps 29 decision cases
        // from breaking on every release bump.
        RELEASE_GATE_PKG: pkgFixture(pkgVersion ?? '0.1.9'),
      },
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

const WAVES = 'wave:0.1.9\nwave:0.2.0\nsev:med\n'

describe.skipIf(LAYOUT !== 'dev')('release-gate.sh', () => {
  it('passes when the wave has no open issues', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9'])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('clean')
  })

  it('refuses and names the issues when the wave is not clear', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '  #42 something unfinished\n' }), ['0.1.9'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('#42')
    expect(r.out).toContain('1 open issue')
  })

  describe('a wave that cannot clear, because something outside it is in the way (#239)', () => {
    // Clause (2) already refuses while the wave holds open issues, so none of this adds
    // gating. It adds the REASON. "Close them, or move them to another wave" is advice the
    // operator cannot take when one of those issues is blocked by work scheduled for a later
    // release, and before this the gate said nothing about that.
    const ONE_OPEN = '  #42 something unfinished\n'

    it('REFUSES AND NAMES THE BLOCKER WHEN IT IS IN A LATER WAVE', () => {
      const r = gate(
        stubGh({ labels: WAVES, issues: ONE_OPEN, blockedBy: '99 open wave:0.2.0\n' }),
        ['0.1.9'],
      )
      expect(r.rc).toBe(1)
      expect(r.out).toContain('cannot clear')
      expect(r.out).toContain('#42 is blocked by #99')
      expect(r.out).toContain('wave:0.2.0')
    })

    it('REFUSES A BLOCKER WITH NO WAVE AT ALL, which is the worse case', () => {
      // An unscheduled blocker has no release in which it will ever close, so the wave it
      // blocks can never clear. Reported as "no wave" rather than skipped for lacking a label.
      const r = gate(stubGh({ labels: WAVES, issues: ONE_OPEN, blockedBy: '99 open \n' }), [
        '0.1.9',
      ])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('#42 is blocked by #99')
      expect(r.out).toContain('no wave')
    })

    it('says nothing when the blocker is in the SAME wave', () => {
      // Clause (2) already names it and both must close either way. Reporting it here would
      // fire on every ordinary wave that happens to use a dependency edge, which is how a
      // gate earns a habit of being overridden.
      const r = gate(
        stubGh({ labels: WAVES, issues: ONE_OPEN, blockedBy: '99 open wave:0.1.9\n' }),
        ['0.1.9'],
      )
      expect(r.rc).toBe(1)
      expect(r.out).toContain('1 open issue')
      expect(r.out).not.toContain('cannot clear')
    })

    it('says nothing when the blocker is already closed', () => {
      const r = gate(
        stubGh({ labels: WAVES, issues: ONE_OPEN, blockedBy: '99 closed wave:0.2.0\n' }),
        ['0.1.9'],
      )
      expect(r.rc).toBe(1)
      expect(r.out).not.toContain('cannot clear')
    })

    it('REFUSES A DEPENDENCY LIST IT COULD NOT READ, rather than treating it as empty', () => {
      // Could-not-look is never nothing-found (#108, #109). An unreadable dependency list
      // means "whether this wave can ever clear is unknown", and this gate has been written
      // the wrong way round twice already.
      const r = gate(stubGh({ labels: WAVES, issues: ONE_OPEN, failOn: 'deps' }), ['0.1.9'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('cannot read what #42 is blocked by')
    })

    it('is not consulted at all when the wave is already empty', () => {
      // Nothing to be blocked. Pins that the clause does not query per-issue dependencies on
      // a clean wave, which would be one network call per nothing.
      const stub = stubGh({ labels: WAVES, issues: '' })
      const r = gate(stub, ['0.1.9'])
      expect(r.rc).toBe(0)
      expect(askedOf(stub)).not.toContain('dependencies/blocked_by')
    })

    it('records it under --anyway alongside the other findings', () => {
      const r = gate(
        stubGh({ labels: WAVES, issues: ONE_OPEN, blockedBy: '99 open wave:0.2.0\n' }),
        ['0.1.9', '--anyway', 'shipping the docs fix without the blocker'],
      )
      expect(r.rc).toBe(0)
      expect(r.out).toContain('OVERRIDDEN')
      expect(r.out).toContain('blocked from outside the wave')
      expect(r.out).toContain('#42 is blocked by #99')
      expect(r.out).toContain('shipping the docs fix without the blocker')
    })
  })

  it('refuses a mistyped version rather than reporting an empty wave clean', () => {
    // THE SUBTLE ONE. `0.19` for `0.1.9` queries a label nobody uses, which returns
    // nothing, which without this check reads as "nothing open" while the real wave is
    // untouched. The gate's own silent failure had to be closed before the gate was
    // worth having.
    //
    // The fixture version MATCHES the typo on purpose, so this case still exercises
    // clause (1) rather than stopping at the artifact binding added for #296. Each clause
    // is tested where it decides; the binding has its own two cases below.
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.19'], '0.19')
    expect(r.rc).toBe(1)
    expect(r.out).toContain('no label')
  })

  // THE ARTIFACT BINDING (#296). The gate queries CI for `git rev-parse HEAD`, so a version
  // naming another release asks about one artifact and reports on another. Clause (1) cannot
  // catch it, because the wrong wave label genuinely EXISTS: with an empty wave:0.1.9 and
  // open work in wave:0.1.10, asking about 0.1.9 at a 0.1.10 commit returned 0.
  it('refuses a version that does not belong to the artifact being checked', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9'], '0.1.10')
    expect(r.rc).toBe(1)
    expect(r.out).toContain('package.json at HEAD says 0.1.10')
  })

  it('refuses when the version cannot be read, rather than trusting the argument', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9'], undefined)
    // A fixture that is not JSON at all: "cannot tell" must not read as "they match".
    const bad = mkdtempSync(join(tmpdir(), 'mp-pkg-bad-'))
    writeFileSync(join(bad, 'package.json'), '{ not json')
    const r2 = (() => {
      try {
        const out = execFileSync('bash', ['scripts/release-gate.sh', '0.1.9'], {
          cwd: REPO,
          encoding: 'utf8',
          env: {
            ...process.env,
            RELEASE_GATE_CMD: stubGh({ labels: WAVES, issues: '' }),
            RELEASE_GATE_REPO: 'example/repo',
            RELEASE_GATE_PKG: join(bad, 'package.json'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return { rc: 0, out }
      } catch (e) {
        const x = e as { status?: number; stdout?: string; stderr?: string }
        return { rc: x.status ?? -1, out: (x.stdout ?? '') + (x.stderr ?? '') }
      }
    })()
    expect(r.rc, r.out).toBe(0)
    expect(r2.rc).toBe(1)
    expect(r2.out).toContain('cannot read a version')
  })

  it('refuses when the label query fails, rather than calling it clean', () => {
    const r = gate(stubGh({ failOn: 'label' }), ['0.1.9'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('Refusing')
  })

  it('refuses when the issue query fails, rather than calling it clean', () => {
    const r = gate(stubGh({ labels: WAVES, failOn: 'issue' }), ['0.1.9'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('Refusing')
  })

  it('allows an override that states a reason, and prints it', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '  #42 deferred on purpose\n' }), [
      '0.1.9',
      '--anyway',
      'moved to 0.1.10, release is time-boxed',
    ])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('OVERRIDDEN')
    expect(r.out).toContain('time-boxed')
  })

  it('refuses an override with no reason', () => {
    // Without this the escape hatch can be used silently, which retires the gate.
    const r = gate(stubGh({ labels: WAVES, issues: '  #42 x\n' }), ['0.1.9', '--anyway'])
    expect(r.rc).toBe(2)
    expect(r.out).toContain('needs a reason')
  })

  it('says so when an override was not needed', () => {
    // Silence here would train the operator to pass --anyway by habit, which retires
    // the gate by attrition rather than by decision.
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9', '--anyway', 'belt and braces'])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('was not needed')
  })

  it('refuses an unknown argument instead of ignoring it', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9', '--force'])
    expect(r.rc).toBe(2)
    expect(r.out).toContain('unknown argument')
  })

  /**
   * The cross-platform clause (#212).
   *
   * Windows and macOS are off the push path on purpose (2x and 10x billing), so a platform
   * regression on main is caught by a pull request, the weekly schedule, or a dispatch. The
   * weekly run went red, had been red for four hours, and two pushes went out on top of it,
   * because nothing read it. This clause reads it at the one moment it decides something.
   */
  describe('the cross-platform clause', () => {
    it('passes when a cross-platform run for this commit is green', () => {
      const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9'])
      expect(r.rc).toBe(0)
      expect(r.out).toContain('cross-platform is green')
    })

    it('asks about this commit own SHA rather than the last run', () => {
      // THE WRONG QUERY, named: "the last cross-platform run was green" can be answered by
      // a run that predates the release commit by days. The gate must say which commit it
      // is asking about, so the stub records what it was asked.
      const stub = stubGh({ labels: WAVES, issues: '' })
      const r = gate(stub, ['0.1.9'])
      expect(r.rc).toBe(0)
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
      expect(askedOf(stub)).toContain(`--commit ${head.trim()}`)
    })

    it('refuses when CI has no cross-platform result for this commit at all', () => {
      const r = gate(stubGh({ labels: WAVES, issues: '', runs: '' }), ['0.1.9'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('no cross-platform result for this commit')
    })

    it('treats a cancelled cross-platform leg as not green', () => {
      // THE REGISTERED CASE, and the hazard recorded on the ticket. A dispatch seconds
      // after a push superseded the push's run twice on 2026-10-05, and one leg itself
      // ended `cancelled`: no result at all. Reading "nothing said failure" as "passed" is
      // the defect this codebase refuses in #108 and #109. The mutation turns the test
      // from `= success` into `!= failure`, after which this run reads as green.
      const jobs = legs([
        ['success', 'cross-platform (windows-latest, 24)'],
        ['cancelled', 'cross-platform (macos-latest, 24)'],
        ['success', 'cross-platform (ubuntu-26.04, 24)'],
      ])
      const r = gate(stubGh({ labels: WAVES, issues: '', jobs }), ['0.1.9'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('cancelled')
    })

    it('refuses when a cross-platform leg failed', () => {
      const jobs = legs([
        ['failure', 'cross-platform (windows-latest, 24)'],
        ['success', 'cross-platform (macos-latest, 24)'],
        ['success', 'cross-platform (ubuntu-26.04, 24)'],
      ])
      const r = gate(stubGh({ labels: WAVES, issues: '', jobs }), ['0.1.9'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('windows-latest')
    })

    it('refuses when a leg has no conclusion yet', () => {
      // An in-flight run has an empty conclusion. It is not a failure and it is not
      // evidence either, and the gate is run at a moment when waiting is the answer.
      const jobs = legs([
        ['success', 'cross-platform (windows-latest, 24)'],
        [null, 'cross-platform (macos-latest, 24)'],
        ['success', 'cross-platform (ubuntu-26.04, 24)'],
      ])
      const r = gate(stubGh({ labels: WAVES, issues: '', jobs }), ['0.1.9'])
      expect(r.rc).toBe(1)
    })

    it('does not accept a push run whose cross-platform job was skipped', () => {
      // MEASURED against the live API on 2026-10-06, not assumed: on a push, GitHub records
      // the excluded job as ONE job named `cross-platform` with conclusion `skipped`, while
      // the run still concludes `success`. A run-level query would read that as proof of a
      // Windows result the run never produced.
      const r = gate(
        stubGh({ labels: WAVES, issues: '', jobs: legs([['skipped', 'cross-platform']]) }),
        ['0.1.9'],
      )
      expect(r.rc).toBe(1)
      expect(r.out).toContain('skipped')
    })

    it('refuses when fewer legs ran than the matrix has', () => {
      const jobs = legs([
        ['success', 'cross-platform (windows-latest, 24)'],
        ['success', 'cross-platform (macos-latest, 24)'],
      ])
      const r = gate(stubGh({ labels: WAVES, issues: '', jobs }), ['0.1.9'])
      expect(r.rc).toBe(1)
    })

    it('refuses when the run query fails, rather than calling it green', () => {
      const r = gate(stubGh({ labels: WAVES, issues: '', failOn: 'runs' }), ['0.1.9'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('Refusing')
    })

    // THE BOUNDARY ITSELF (#298). The projection is production code now, so an answer it
    // cannot read must refuse rather than yield no legs — "could not look" is not
    // "nothing found" (#108, #109). Neither shape was reachable while a stub answered with
    // pre-formatted lines.
    it('refuses when the run view is not JSON', () => {
      const r = gate(stubGh({ labels: WAVES, issues: '', jobs: '{ not json' }), ['0.1.9'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('cannot read the cross-platform legs')
    })

    it('refuses when the run view holds no jobs array', () => {
      const r = gate(stubGh({ labels: WAVES, issues: '', jobs: '{"runs":[]}' }), ['0.1.9'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('cannot read the cross-platform legs')
    })

    // An empty jobs array IS an answer: the run ran no cross-platform legs. It must not be
    // confused with the unreadable cases above, and it must not pass.
    it('treats a run with no cross-platform legs as no evidence, not as unreadable', () => {
      const r = gate(stubGh({ labels: WAVES, issues: '', jobs: JSON.stringify({ jobs: [] }) }), [
        '0.1.9',
      ])
      expect(r.rc).toBe(1)
      expect(r.out).not.toContain('cannot read')
    })

    it('refuses when a run jobs cannot be read, rather than calling it green', () => {
      const r = gate(stubGh({ labels: WAVES, issues: '', failOn: 'jobs' }), ['0.1.9'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('Refusing')
    })

    it('allows an override of a red cross-platform result and names what it covered', () => {
      // The override must SAY which clause it waived. "OVERRIDDEN, reason: moved to 0.1.10"
      // beside a reason written about the wave would otherwise silently cover a red
      // platform result as well.
      const r = gate(stubGh({ labels: WAVES, issues: '', runs: '' }), [
        '0.1.9',
        '--anyway',
        'windows runner outage, retried twice',
      ])
      expect(r.rc).toBe(0)
      expect(r.out).toContain('OVERRIDDEN')
      expect(r.out).toContain('no green cross-platform run')
      expect(r.out).toContain('runner outage')
    })

    it('is not waived by an override granted for open issues alone', () => {
      // The verdict used to be decided inside the open-issues branch, which returned 0 on
      // --anyway before any later clause ran. This pins the restructure: an override prints
      // BOTH findings, so neither is lost behind the other.
      const r = gate(stubGh({ labels: WAVES, issues: '  #42 deferred\n', runs: '' }), [
        '0.1.9',
        '--anyway',
        'time-boxed release',
      ])
      expect(r.rc).toBe(0)
      expect(r.out).toContain('still has 1 open issue')
      expect(r.out).toContain('no green cross-platform run')
    })

    it('requires as many legs as the cross-platform matrix in ci.yml declares', () => {
      // THE DRIFT CHECK. The gate holds the leg count as a literal, so ci.yml could grow or
      // lose a platform and the gate would go on asserting the old coverage. This is the
      // mechanism that makes that change visible at commit time rather than at a release.
      const gateSrc = readFileSync(join(REPO, 'scripts/release-gate.sh'), 'utf8')
      const declared = /^CROSS_PLATFORM_LEGS=(\d+)$/m.exec(gateSrc)
      expect(declared).not.toBeNull()

      const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8')
      const parts = ci.split('\n  cross-platform:\n')
      // Exactly one such job, so a rename makes this fail rather than silently measure
      // nothing. `toBeDefined` would not do: it is not a type narrowing, and tsc says so.
      expect(parts.length).toBe(2)
      const legs = (parts[1] ?? '').match(/^ {10}- os: /gm) ?? []
      // Not `toBe(legs.length)` alone: a parse that found nothing would otherwise make this
      // pass by agreeing with a gate that required nothing.
      expect(legs.length).toBeGreaterThan(0)
      expect(Number(declared?.[1])).toBe(legs.length)
    })
  })
})
