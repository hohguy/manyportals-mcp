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
  // Signing OFF for fixtures (#182). Global config now signs every commit through
  // 1Password's agent, so without this a fixture commit fails whenever the vault is
  // locked — a developer-machine-only flake that CI never sees and nobody diagnoses fast.
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: d, stdio: 'ignore' })
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

/** Drive ONLY the manifest-versus-index decision (#295). */
function auditManifest(manifest: string, index: string): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/publish-sync.sh'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, AUDIT_MANIFEST: manifest, AUDIT_INDEX: index },
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

/** Run the assembler for real, expecting it to refuse before doing anything. */
function runWith(env: Record<string, string>, args: string[]): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/publish-sync.sh', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, ...env },
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

/**
 * Drive ONLY the release-tag anchor resolution (#218). The live path needs a FETCHED base,
 * which no test can produce from a working copy, so the decision takes a local repository.
 */
function auditTag(dir: string, rev = 'HEAD'): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/publish-sync.sh'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, AUDIT_TAG_DIR: dir, AUDIT_TAG_REV: rev },
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

/**
 * Drive ONLY the foreign-commit overlap decision (#218), through the same kind of door
 * `AUDIT_BASE_DIR` opens for #116. The live check reads `git diff --cached`, which exists
 * only part-way through an assembly, and the assembler refuses a dirty dev tree by design —
 * so the decision takes two file lists and the test supplies them.
 */
function auditForeign(foreign: string[], staged: string[]): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/publish-sync.sh'], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        AUDIT_FOREIGN_FILES: foreign.join('\n'),
        AUDIT_STAGED_FILES: staged.join('\n'),
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

    it('REFUSES A BASE WITH NO RELEASE TAG, rather than comparing against nothing', () => {
      // The anchor separating a release commit from a direct edit is the release tag. With
      // no tag the two are indistinguishable, and "cannot tell" must never read as "nothing
      // found" — the defect this codebase refuses everywhere (#108, #109).
      const r = auditTag(gitRepo({ 'README.md': '# Public\n' }))
      expect(r.rc).toBe(1)
      expect(r.out).toContain('no release tag is reachable')
    })

    it('anchors on the last release tag when there is one', () => {
      // The control. Without it the case above is satisfied by refusing everything.
      const d = gitRepo({ 'README.md': '# Public\n' })
      execFileSync('git', ['tag', '-a', 'v0.0.1', '-m', 'r'], { cwd: d, stdio: 'ignore' })
      const r = auditTag(d)
      expect(r.rc).toBe(0)
      expect(r.out).toContain('v0.0.1')
    })

    it('REFUSES A RELEASE THAT WOULD OVERWRITE A FILE A FOREIGN COMMIT TOUCHED', () => {
      // #218. `read-tree HEAD` then `add -A` means the assembled content WINS, so a commit
      // made directly on public main — a merged pull request, a typo fix — keeps its COMMIT
      // and loses its CONTENT at the next release. The #166 postcondition compares path
      // COUNT, not content, so a reverting release looked like every other release: the
      // contributor sees the merge, and weeks later the change is gone with no failed build.
      const r = auditForeign(['README.md', 'docs/SAFETY.md'], ['package.json', 'docs/SAFETY.md'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('docs/SAFETY.md')
      // and names only the overlap, not every foreign file
      expect(r.out).not.toContain('README.md')
    })

    it('accepts a foreign commit whose files the assembly does not touch', () => {
      // The normal case after a back-port: the change is in dev too, so the assembly agrees
      // with it and there is nothing to take back. Refusing here would make the guard fire
      // on every release after any merge, which is how a guard gets switched off.
      const r = auditForeign(['README.md'], ['package.json', 'src/index.ts'])
      expect(r.rc).toBe(0)
      expect(r.out).toContain('clean')
    })

    it('matches whole paths, not prefixes', () => {
      // `docs/SAFETY.md` must not be considered overwritten by a staged `docs/SAFETY.md.bak`
      // or by `docs/SAFETY`. A substring comparison here would refuse real releases.
      const r = auditForeign(['docs/SAFETY.md'], ['docs/SAFETY.md.bak', 'docs/SAFETY'])
      expect(r.rc).toBe(0)
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

/**
 * The release-machinery review, 2026-10-07. Three decisions that had no test at all, each
 * driven through a door rather than through an assembly, because this script refuses a dirty
 * dev tree by design.
 */
describe.skipIf(LAYOUT !== 'dev')('publish-sync release-machinery decisions', () => {
  // ── THE RELEASE-MACHINERY REVIEW (2026-10-07) ────────────────────────────────

  // #295, the most consequential finding. Every audit in this script reads the WORKING
  // TREE; the commit comes from `git add -A`, which silently omits an ignored untracked
  // path. Reproduced against the real assembler: an excludesFile naming src/index.ts gave
  // 128 audited files, every audit green, and an index of 69 source files with no
  // src/index.ts. "Audited on disk" is not "published" (#108, #109).
  it('refuses when a copied file never reaches the commit index', () => {
    const r = auditManifest('src/index.ts\nsrc/a.ts\n', 'src/a.ts\n')
    expect(r.rc).toBe(1)
    expect(r.out).toContain('src/index.ts')
  })

  it('accepts an index that holds every copied path, and more', () => {
    const r = auditManifest('src/a.ts\n', 'src/a.ts\nREADME.md\n')
    expect(r.rc, r.out).toBe(0)
  })

  // #297. `describe --tags` returns any tag and prefers one on the target commit, so a
  // `checkpoint` tag placed on a direct public correction became the anchor: the
  // foreign-change window is then empty and the overwrite decision that exists to stop a
  // release silently reverting that correction (#218) is skipped entirely.
  it('refuses a non-release tag as the foreign-change anchor', () => {
    const d = gitRepo({ 'README.md': 'base\n' })
    execFileSync('git', ['tag', 'checkpoint'], { cwd: d, stdio: 'ignore' })
    const r = auditTag(d)
    expect(r.rc).toBe(1)
    // `--match` filters it out before the grammar check, so the refusal is "none reachable".
    // The grammar check below it stays as defence for a tag the glob admits and the rule
    // does not; it is deliberately belt-and-braces and no fixture can reach it.
    expect(r.out).toContain('no release tag is reachable')
  })

  it('accepts a release tag as the anchor, with a non-release tag also present', () => {
    const d = gitRepo({ 'README.md': 'base\n' })
    execFileSync('git', ['tag', 'v0.1.9'], { cwd: d, stdio: 'ignore' })
    execFileSync('git', ['tag', 'checkpoint'], { cwd: d, stdio: 'ignore' })
    const r = auditTag(d)
    expect(r.rc, r.out).toBe(0)
    expect(r.out).toContain('v0.1.9')
  })

  // #299. The audit doors dispatch on whether a variable is SET, including set to empty,
  // and they run before source cleanliness, output safety and assembly. So an inherited
  // variable made `--out X --no-verify` exit 0, print "clean", and create no output: a
  // false SUCCESS in the command the release ceremony runs.
  it('refuses an audit variable supplied beside assembly arguments', () => {
    const out = mkdtempSync(join(tmpdir(), 'mp-assembly-'))
    const r = runWith({ AUDIT_FOREIGN_FILES: '' }, ['--out', out, '--no-verify'])
    expect(r.rc).toBe(2)
    expect(r.out).toContain('AUDIT_FOREIGN_FILES is set and assembly arguments were given')
  })
})
