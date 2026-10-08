import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The last gate before `npm publish` uploads. Its scope has to be the set npm PACKS,
 * and it was not:
 *
 * - The git-based scans see git's view of the tree, while npm's `files[]` OVERRIDES
 *   ignore rules. Three git-ignored files under examples/ carrying synthetic
 *   credentials were reported clean by every git-based gate and packed by npm. The
 *   filesystem walker DID see them; nothing pointed it at that directory (#110 5a).
 * - `files[]` existence was satisfied by a present-but-EMPTY dist/, while npm packed
 *   no entry point at all (#110 5d).
 *
 * `public/.gitignore` carries those ignore rules precisely because operators keep such
 * files beside a checkout, so the rule prevents the commit and creates false confidence
 * about the publish.
 */
const REPO = process.cwd()
/**
 * Every case here spawns `npm pack`, and the guard spawns it again. Alone that is
 * comfortably under a second; inside the full suite, under contention, it is not, and
 * vitest's 5s default turned a passing guard into a red test that said nothing about
 * the guard. The same thing happened to the register's self-tests.
 */
const SPAWNS_NPM = 60_000
const PAT = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')

/** A minimal tree in the assembled PUBLIC layout, which is where this guard runs. */
function publicTree(
  opts: { emptyEntry?: boolean; extra?: Record<string, string>; ignore?: string[] } = {},
): string {
  const d = mkdtempSync(join(tmpdir(), 'prepub-'))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  for (const f of [
    'prepublish-guard.sh',
    'credscan.sh',
    'cred-pattern.sh',
    'cred-scan-tree.sh',
    'layout.sh',
  ]) {
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f))
  }
  writeFileSync(join(d, '.manyportals-layout'), 'public\n')
  writeFileSync(
    join(d, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-pkg',
        version: '0.0.1',
        main: './dist/index.js',
        bin: { 'fixture-pkg': './dist/index.js' },
        files: ['dist', 'examples'],
      },
      null,
      2,
    ) + '\n',
  )
  mkdirSync(join(d, 'dist'), { recursive: true })
  writeFileSync(join(d, 'dist', 'index.js'), opts.emptyEntry === true ? '' : 'console.log(1)\n')
  mkdirSync(join(d, 'examples'), { recursive: true })
  writeFileSync(join(d, 'examples', 'README.md'), '# Examples\n')
  // The ignore rules an operator's checkout really carries.
  writeFileSync(
    join(d, '.gitignore'),
    ['tokens.json', '*.key', '*.pem', 'manyportals.config.json', ...(opts.ignore ?? [])].join(
      '\n',
    ) + '\n',
  )
  for (const [rel, body] of Object.entries(opts.extra ?? {})) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d, stdio: 'ignore' })
  execFileSync('git', ['add', '-A'], { cwd: d, stdio: 'ignore' })
  // Committed, so `git status --porcelain` is genuinely empty and the premise the
  // ignored-file case asserts is the operator's real situation: a clean checkout.
  execFileSync(
    'git',
    // -c commit.gpgsign=false for the same reason as publish-sync.test.ts's fixture
    // (#182): global config signs through 1Password, and a locked vault would fail this.
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: d, stdio: 'ignore' },
  )
  return d
}

function guard(dir: string, env: Record<string, string> = {}): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/prepublish-guard.sh'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
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

/** What npm would actually put in the tarball. */
function packedPaths(dir: string): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entries = JSON.parse(out) as Array<{ files?: Array<{ path: string }> }>
  return (entries[0]?.files ?? []).map((f) => f.path)
}

/**
 * An `npm` shim whose `pack --dry-run --json` reports paths of the caller's choosing.
 *
 * It exists for ONE input that real npm cannot produce: a packed path that is not a
 * readable regular file. The guard counts such a path as PACKED, cannot scan it, and so
 * does not count it as SCANNED — which is the only thing the completeness assertion is
 * for. Nothing stageable from outside reaches that branch otherwise (an unreadable file
 * trips the grep-error branch first), which is exactly why a reviewer's mutation of the
 * assertion survived every prepublish test (2026-09-29 review, finding 11).
 *
 * Returns a directory to put at the front of PATH.
 */
function npmShim(dir: string, reported: string[]): string {
  const bin = join(dir, 'shim-bin')
  mkdirSync(bin, { recursive: true })
  const payload = JSON.stringify([{ files: reported.map((p) => ({ path: p })) }])
  // Only `pack` is answered; any other subcommand fails loudly rather than letting the
  // shim quietly satisfy a call it was not written for.
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      'if [ "$1" != pack ]; then exit 90; fi',
      "cat <<'SHIM_JSON'",
      payload,
      'SHIM_JSON',
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'npm'), 0o755)
  return bin
}

/**
 * POSIX only, and deliberately.
 *
 * This gate is bash, it shells out to `npm pack`, and it compares the paths npm
 * reports against paths it stats. On Windows those disagree on separators, so the
 * guard's completeness assertion does not match and it REFUSES to publish. That is
 * the safe direction, and a publish happens from the assembled public repo on a
 * maintainer's POSIX machine, so the behaviour that matters is covered here.
 *
 * What is NOT covered is a maintainer running `npm publish` on Windows: they would
 * see a refusal they cannot act on. Recorded on #96, which tracks the Windows leg
 * running bash scripts, rather than left as an unexplained skip.
 */
describe.skipIf(process.platform === 'win32')(
  'prepublish-guard scopes itself to what npm packs (#110)',
  () => {
    it(
      'passes a clean public tree',
      () => {
        const d = publicTree()
        const r = guard(d)
        expect(r.rc).toBe(0)
        expect(r.out).toContain('file(s) npm would pack')
        rmSync(d, { recursive: true, force: true })
      },
      SPAWNS_NPM,
    )

    it(
      'refuses a credential in a GIT-IGNORED file that npm packs anyway',
      () => {
        const d = publicTree({ extra: { 'examples/tokens.json': `{"PORTAL_A":"${PAT}"}\n` } })
        // The premise, asserted rather than assumed: git does not see it, npm does.
        expect(
          execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' }).trim(),
        ).toBe('')
        expect(packedPaths(d)).toContain('examples/tokens.json')

        const r = guard(d)
        expect(r.rc).not.toBe(0)
        expect(r.out).toContain('examples/tokens.json')
        expect(r.out).toContain('would PACK')
        // The file name is named; the secret itself never is.
        expect(r.out).not.toContain(PAT)
        rmSync(d, { recursive: true, force: true })
      },
      SPAWNS_NPM,
    )

    it(
      'refuses a PEM private key in an ignored file',
      () => {
        const PEM = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
        const d = publicTree({ extra: { 'examples/portal.key': `${PEM}\n` } })
        expect(packedPaths(d)).toContain('examples/portal.key')
        expect(guard(d).rc).not.toBe(0)
        rmSync(d, { recursive: true, force: true })
      },
      SPAWNS_NPM,
    )

    it(
      'examines every file npm would pack, not a subset',
      () => {
        // The acceptance criterion stated directly: the set scanned equals the set packed.
        const d = publicTree()
        const r = guard(d)
        expect(r.out).toContain(`scanned all ${packedPaths(d).length} file(s) npm would pack`)
        rmSync(d, { recursive: true, force: true })
      },
      SPAWNS_NPM,
    )

    it(
      'refuses a credential in a packed file whose NAME contains a newline (#122)',
      () => {
        // The reviewer's exact input from the 2026-09-29 review, finding 1.
        const NL = 'examples/PORTAL_A\nNOTICE'
        const d = publicTree({
          extra: {
            [NL]: `{"PORTAL_A":"${PAT}"}\n`,
            // Both HALVES of the newline name are real, benign files, and that is the
            // load-bearing part of the input rather than decoration. The old code split
            // the name into two lines; because each half resolved to a real file, each
            // was opened, read, found clean and COUNTED, so PACKED and SCANNED agreed
            // and the completeness assertion confirmed a scan that never touched the
            // credential. Remove either file and a regression would announce itself as
            // a count mismatch instead of passing silently, so they have to stay.
            'examples/PORTAL_A': 'PORTAL_A example, nothing secret.\n',
            NOTICE: 'Notice text, nothing secret.\n',
          },
          // git-IGNORED, also load-bearing: credscan uses `git grep --untracked`, so a
          // merely-untracked file is caught there and never reaches this code path.
          ignore: ['examples/*NOTICE'],
        })

        // Premises, asserted rather than assumed.
        expect(
          execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' }).trim(),
        ).toBe('')
        const packed = packedPaths(d)
        // npm reports it as ONE path...
        expect(packed).toContain(NL)
        // ...which flattening to lines turns into one MORE entry than there are paths.
        expect(packed.join('\n').split('\n')).toHaveLength(packed.length + 1)

        const r = guard(d)
        expect(r.rc).not.toBe(0)
        expect(r.out).toContain('would PACK')
        // Reported escaped, so one hit can never be read as two paths.
        expect(r.out).toContain(JSON.stringify(NL))
        // The count comes from the PARSED array: as many as npm named, not the lines a
        // reserialization yields.
        expect(r.out).toContain(`scanned all ${packed.length} file(s) npm would pack`)
        // The file is named; the secret never is.
        expect(r.out).not.toContain(PAT)
        rmSync(d, { recursive: true, force: true })
      },
      SPAWNS_NPM,
    )

    it(
      'refuses when a packed path cannot be scanned, with no grep error involved (#122)',
      () => {
        const d = publicTree()
        const real = packedPaths(d)
        const GHOST = 'examples/never-written.json'
        expect(existsSync(join(d, GHOST))).toBe(false)
        const bin = npmShim(d, [...real, GHOST])

        const r = guard(d, { PATH: `${bin}:${process.env.PATH ?? ''}` })
        expect(r.rc).not.toBe(0)
        expect(r.out).toContain(
          `examined ${real.length} of the ${real.length + 1} file(s) npm would pack`,
        )
        // Isolation, asserted mechanically rather than argued. Until this shim existed,
        // the completeness branch could only be reached alongside the grep-error branch,
        // so no test could tell which of the two had refused.
        expect(r.out).not.toContain('cannot scan')
        // A partial scan must not ALSO claim it read everything.
        expect(r.out).not.toContain('scanned all')
        rmSync(d, { recursive: true, force: true })
      },
      SPAWNS_NPM,
    )

    it(
      'refuses an entry point that exists but is empty',
      () => {
        // `files[]` names `dist`, a DIRECTORY, so existence of the directory satisfied the
        // old check while npm packed no runnable entry point.
        const d = publicTree({ emptyEntry: true })
        const r = guard(d)
        expect(r.rc).not.toBe(0)
        expect(r.out).toContain('empty')
        rmSync(d, { recursive: true, force: true })
      },
      SPAWNS_NPM,
    )
  },
)
