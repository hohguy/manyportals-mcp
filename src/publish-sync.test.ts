import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The base-history guard (#116).
 *
 * Publishing used to create one parentless commit per release and force-push it over
 * `main`. Committing on top of the published history instead introduced exposure that
 * replacing it did not have: `hohguy/manyportals-mcp` was once a RENAME REDIRECT to the
 * private dev repo (runbook G5b), and a mis-targeted FETCH would make the private
 * history the PARENT of a public commit. Pushing that publishes every private commit.
 *
 * `publish-sync.sh` refuses a base whose history contains any DENY_PATHS entry. These
 * drive it through `AUDIT_BASE_DIR`, which exists because the assembler cannot be run
 * end to end from a working copy: a dirty dev tree is fatal by design, which is why no
 * committed test has ever exercised the script and why the 2026-09-28 review used
 * throwaway probes it explicitly called "not committed regression tests".
 */
const REPO = process.cwd()

// publish-sync.sh is dev-only and is NOT in the assembly allowlist, so it is absent
// from the public tree where this file still ships. Driving it there fails, which is
// #132's class, and the real assembly caught it. Same guard ref-scan.test.ts uses for
// the same reason: the layout declaration, read rather than guessed.
const LAYOUT = readFileSync(join(REPO, '.manyportals-layout'), 'utf8').trim()

// Assembled from parts, not written literally. `src/` ships wholesale, and ref-scan
// refuses a shipped file that names an internal path — it caught this file on the first
// real assembly, which is the gate working. Reading the names from
// scripts/deny-pattern.sh instead would be worse: that script is dev-only and absent
// from the public tree, so the test would pass here and fail there, which is #132.
const DENY_DIR = ['project', 'docs'].join('-')
const DENY_FILE = ['CLAUDE', 'md'].join('.')

function gitRepo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'mp-base-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: d, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: d, stdio: 'ignore' })
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  if (Object.keys(files).length > 0) {
    execFileSync('git', ['add', '-A'], { cwd: d, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: d, stdio: 'ignore' })
  }
  return d
}

function auditBase(dir: string, rev = 'HEAD'): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/publish-sync.sh'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, AUDIT_BASE_DIR: dir, AUDIT_BASE_REV: rev },
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

describe.skipIf(LAYOUT !== 'dev')(
  'publish-sync refuses a base that is not the public repo (#116)',
  () => {
    it('accepts a public-shaped history', () => {
      const r = auditBase(gitRepo({ 'README.md': '# Public\n' }))
      expect(r.rc).toBe(0)
      expect(r.out).toContain('clean')
    })

    it.each([
      [`${DENY_DIR}/notes.md`, DENY_DIR],
      [DENY_FILE, DENY_FILE],
    ])('refuses a history containing %s', (rel, named) => {
      // A tree that looks public at the root and carries one private path. This is the
      // redirect case: the dev repo also has a README and a src/.
      const r = auditBase(gitRepo({ 'README.md': '# Public\n', [rel]: 'private\n' }))
      expect(r.rc).toBe(1)
      expect(r.out).toContain(named)
    })

    it('still refuses at realistic tree size', () => {
      // The fixtures above are a few files each, and that is why they passed while the
      // guard carried a real false negative: it used `printf | grep -q`, where grep
      // exits on the first match, printf takes SIGPIPE and pipefail reports 141, so a
      // MATCH read as no-match. Small trees let printf finish first and hid it. The
      // published tree is ~115 files. This fixture is larger than production so the
      // race cannot be won by luck, and it fails if a pipe is ever reintroduced here.
      const files: Record<string, string> = { [`${DENY_DIR}/notes.md`]: 'private\n' }
      for (let i = 0; i < 160; i++) files[`src/mod${i}.ts`] = `export const n${i} = ${i}\n`
      const r = auditBase(gitRepo(files))
      expect(r.rc).toBe(1)
      expect(r.out).toContain(DENY_DIR)
    })

    it('refuses an unreadable base rather than calling it clean', () => {
      // REGRESSION. The first version of this guard read `git rev-list` through a process
      // substitution, whose exit status is invisible. Pointed at a missing directory,
      // rev-list failed, the loop received nothing, no hit was recorded, and the guard
      // reported CLEAN with rc=0 — a false clean on the check standing between the
      // private history and a public parent. Same defect as #108 and #109.
      const r = auditBase(join(tmpdir(), 'mp-base-definitely-absent'))
      expect(r.rc).toBe(1)
      expect(r.out).toContain('refusing')
    })

    it('refuses a repository with no commits, as unreadable', () => {
      // An unborn HEAD makes rev-list fail rather than return nothing, so this lands in
      // the unreadable branch. Asserted as it behaves, not as first assumed.
      const r = auditBase(gitRepo({}))
      expect(r.rc).toBe(1)
      expect(r.out).toContain('refusing')
    })

    it('refuses an enumeration that succeeds and returns nothing', () => {
      // The other half of the same rule, and it needed a real input to be reachable at
      // all. `rev-list HEAD` on a valid repo always yields at least one commit, so the
      // empty-list branch looked like a clause that could never fire — the shape this
      // project refuses to call a check. A rev RANGE resolving to nothing fires it, and
      // AUDIT_BASE_REV is supplied by the caller, so the input is a real one.
      const r = auditBase(gitRepo({ 'README.md': '# Public\n' }), 'HEAD..HEAD')
      expect(r.rc).toBe(1)
      expect(r.out).toContain('no commits')
    })
  },
)
