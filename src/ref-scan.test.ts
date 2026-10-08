import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ref-scan.sh is the gate that stops a shipped file naming a private document. Its
 * whole interface is the exit status, and the case that made it a file of its own is
 * the exemption filter: publish-sync.sh used to recover each filename by truncating a
 * grep line at its first colon, so `src/source-guard.test.ts:PORTAL_A` truncated to
 * the exempt `src/source-guard.test.ts` and inherited another file's exemption (#125).
 *
 * Every case below drives the real script against a real tree. None of them reads its
 * source: a filter proven only by the shape of its code is the defect this repo keeps
 * finding.
 */
const REPO = process.cwd()

/**
 * Assembled from parts for the reason cred-scan-tree.test.ts assembles its PAT: a
 * contiguous literal here would make this very file a private-reference surface, and
 * the gate under test would then refuse to publish src/. `src/source-guard.test.ts` is
 * exempt by name; widening that list to accommodate a new test would be fixing the test
 * by loosening the gate.
 */
const PRIVATE_REF = ['project', 'docs/'].join('-')

/**
 * DEV-ONLY, like the assembler that is its only caller. `scripts/ref-scan.sh` is not in
 * publish-sync's allowlist, so in the ASSEMBLED public tree it is absent by design and
 * these cases have nothing to run. Which tree this is, is DECLARED rather than sniffed
 * (#107), read the same way guard-register.mjs reads it for its own ratchet.
 */
const LAYOUT = readFileSync(join(REPO, '.manyportals-layout'), 'utf8').trim()

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

function scan(dir: string, paths: string[] = []): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/ref-scan.sh', dir, ...paths], {
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

/** A tree in the assembled PUBLIC layout, which is the layout the exemptions name. */
function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'refscan-'))
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return d
}

/**
 * POSIX only. The script is bash, and the headline case needs a filename containing a
 * colon, which Windows cannot create at all. A publish happens from the assembled
 * public repo on a maintainer's POSIX machine, so the behaviour that matters is
 * covered here; the Windows leg is #96.
 */
describe.skipIf(process.platform === 'win32' || LAYOUT !== 'dev')('ref-scan.sh', () => {
  // #125, the reviewer's counterexample verbatim. The title carries no regex
  // metacharacter on purpose: it is named in the guard register's `expect`, which
  // vitest applies as a `-t` REGEX, and a paren or a `#` there would match no test.
  it('does not let a colon in a filename inherit the exemption of another file', () => {
    const d = tree({
      'src/source-guard.test.ts:PORTAL_A': `const REF = "${PRIVATE_REF}architecture.md"\n`,
      'README.md': '# nothing private here\n',
    })
    const r = scan(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('src/source-guard.test.ts:PORTAL_A')
    rmSync(d, { recursive: true, force: true })
  })

  it('still honours the exemption of the file that genuinely holds it', () => {
    // The thing the fix must NOT break. A comparison made over-strict would stop
    // honouring real exemptions, and a gate that refuses a legitimate publish is a
    // different failure that first reads as success.
    const d = tree({
      'src/source-guard.test.ts': `const REF = "${PRIVATE_REF}architecture.md"\n`,
      'README.md': '# nothing private here\n',
    })
    expect(scan(d).rc).toBe(0)
    rmSync(d, { recursive: true, force: true })
  })

  it('reports an ordinary file that references a private doc', () => {
    // The pattern still matches what it always matched, and the exempt file that hits
    // the same pattern is still not reported.
    const d = tree({
      'docs/USAGE.md': `See ${PRIVATE_REF}notes.md\n`,
      'scripts/credscan.sh': `# refuses ${PRIVATE_REF}\n`,
      'README.md': '# nothing private here\n',
    })
    const r = scan(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('docs/USAGE.md')
    expect(r.out).not.toContain('credscan.sh')
    rmSync(d, { recursive: true, force: true })
  })

  it.skipIf(asRoot)('fails closed when part of the tree cannot be read', () => {
    // An unreadable directory stops the enumeration, and a prefix of the tree is not
    // the tree (#109). "I could not look" must not arrive as "nothing to see" (#65).
    const d = tree({
      'sub/hidden.md': `${PRIVATE_REF}notes.md\n`,
      'README.md': '# nothing private here\n',
    })
    chmodSync(join(d, 'sub'), 0o000)
    const r = scan(d)
    chmodSync(join(d, 'sub'), 0o755)
    expect(r.rc).toBe(2)
    expect(r.out).toContain('failing closed')
    rmSync(d, { recursive: true, force: true })
  })

  it('fails closed on an empty tree', () => {
    // A scan with nothing to look at would otherwise be satisfied by deleting its own
    // input, which is the shape of #113.
    const d = mkdtempSync(join(tmpdir(), 'refscan-'))
    const r = scan(d)
    expect(r.rc).toBe(2)
    expect(r.out).toContain('no files found')
    rmSync(d, { recursive: true, force: true })
  })

  it('names the file when exactly one file is scanned', () => {
    // This pins `-H`. grep omits the filename when it is handed a single operand, so a
    // tree whose only non-exempt file is the one that hits would report a private
    // reference with nothing identifying it. The exempt file keeps the operand count at
    // one, which is the whole input.
    const d = tree({
      'docs/USAGE.md': `See ${PRIVATE_REF}notes.md\n`,
      'scripts/credscan.sh': `# refuses ${PRIVATE_REF}\n`,
    })
    const r = scan(d)
    expect(r.rc).toBe(1)
    const lines = r.out.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith('./docs/USAGE.md:')).toBe(true)
    rmSync(d, { recursive: true, force: true })
  })
})

/**
 * THE DEV-MODE SCAN: the same pattern and the same exemption list, over named paths
 * inside a tree rather than the whole of it (#180).
 *
 * The gate used to run only from inside publish-sync.sh, against the assembled tree. So
 * a production file could name a private document, `npm run verify` stayed green, and
 * the repository could not cut a release. That is not hypothetical: src/plans/index.ts
 * carried such a citation from 22013b5 until 6cc6ea8, and only a release attempt could
 * have said so. The first case below is that defect, reproduced, scanned the way verify
 * now scans it.
 *
 * The development tree cannot be scanned whole, which is why this mode takes paths: the
 * private decision history is full of these strings by design. Narrowing is all a
 * caller may do, and the cases below pin both directions of that.
 */
describe.skipIf(process.platform === 'win32' || LAYOUT !== 'dev')(
  'ref-scan.sh over named paths',
  () => {
    it('refuses a src file that names a private doc, which is what a release found', () => {
      const d = tree({
        'src/plans/index.ts': `/** recorded in ${PRIVATE_REF}audits/2026-10-04-review.md */\n`,
        'public/README.md': '# nothing private here\n',
        // The private tree itself, assembled rather than written literally for the
        // reason PRIVATE_REF is. It is here to prove the scan NARROWED: a whole-tree
        // scan of a dev layout is all hits and tells nobody anything.
        [`${PRIVATE_REF}notes.md`]: `${PRIVATE_REF}notes.md\n`,
      })
      const r = scan(d, ['src', 'public'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('src/plans/index.ts')
      expect(r.out).not.toContain('notes.md')
      rmSync(d, { recursive: true, force: true })
    })

    it('scans every path it is given, not just the first', () => {
      // `find "$OPERANDS"` in place of `find "${OPERANDS[@]}"` hands find only the FIRST
      // operand, and the rest of the surface then reads as clean: verify would cover src
      // and silently stop covering public. The reference sits in the LAST path on
      // purpose, because a case whose hit is in the first cannot tell those apart.
      const d = tree({
        'src/index.ts': 'export const x = 1\n',
        'public/docs/USAGE.md': `See ${PRIVATE_REF}notes.md\n`,
      })
      const r = scan(d, ['src', 'public'])
      expect(r.rc).toBe(1)
      expect(r.out).toContain('public/docs/USAGE.md')
      rmSync(d, { recursive: true, force: true })
    })

    it('still exempts by whole path when only part of the tree is scanned', () => {
      // Not a formality. src/source-guard.test.ts holds the reference ON PURPOSE, to
      // prove the guard it names works, so an exemption that applied only in the
      // assembler's whole-tree mode would make the new verify step fail on the test
      // suite that proves these gates can fire.
      const d = tree({
        'src/source-guard.test.ts': `const REF = "${PRIVATE_REF}architecture.md"\n`,
        'src/index.ts': 'export const x = 1\n',
      })
      expect(scan(d, ['src']).rc).toBe(0)
      rmSync(d, { recursive: true, force: true })
    })

    it('fails closed when a named path is not in the tree', () => {
      // A surface that was RENAMED must not read as clean, which is a gate satisfied by
      // deleting part of its own input (#113). It is also why this mode cannot be handed
      // to a shipped package.json script: `public/` does not exist in the assembled
      // tree, and this says so rather than passing over it.
      const d = tree({ 'src/index.ts': 'export const x = 1\n' })
      const r = scan(d, ['src', 'public'])
      expect(r.rc).toBe(2)
      expect(r.out).toContain('failing closed')
      rmSync(d, { recursive: true, force: true })
    })

    it('still refuses a flag, so no caller can widen what is looked at', () => {
      const d = tree({ 'src/index.ts': 'export const x = 1\n' })
      const r = scan(d, ['--exclude-dir=src'])
      expect(r.rc).toBe(2)
      expect(r.out).toContain('unknown argument')
      rmSync(d, { recursive: true, force: true })
    })

    it('scans the whole tree when given no path at all, as the assembler needs', () => {
      // Both modes over one fixture: the file outside src is found when no path is
      // named, and not found when `src` is. publish-sync.sh passes no path and depends
      // on this half behaving exactly as it did, including the `./` the enumeration
      // produces.
      const d = tree({
        'src/index.ts': 'export const x = 1\n',
        'docs/USAGE.md': `See ${PRIVATE_REF}notes.md\n`,
      })
      const whole = scan(d)
      expect(whole.rc).toBe(1)
      expect(whole.out).toContain('./docs/USAGE.md')
      expect(scan(d, ['src']).rc).toBe(0)
      rmSync(d, { recursive: true, force: true })
    })
  },
)

/**
 * THE MIRROR ITSELF (#180). Everything above drives fixtures; this one asserts the
 * property over THIS repository, which is the gate that was missing.
 *
 * It lives in the test suite rather than in a package.json script, and that was
 * measured rather than preferred: package.json SHIPS, and the assembler's audit gate
 * (E) runs scripts/command-paths.mjs over the staged tree, where a `verify` step naming
 * scripts/ref-scan.sh is a command naming a file the public tree does not hold. Adding
 * one there refuses the assembly with `runs scripts/ref-scan.sh, which is not in this
 * tree` — the #180 failure mode, caused by the fix for #180. `npm run verify` runs
 * `npm test`, so the gate is local either way, and src/egress.test.ts already asserts a
 * property of the real src/ tree from inside the suite.
 */
describe.skipIf(process.platform === 'win32' || LAYOUT !== 'dev')(
  'the shipped surface of this tree',
  () => {
    it('names no private document in src or public', () => {
      const r = scan(REPO, ['src', 'public'])
      // The lines first: a failure should name the file and the sentence, not just a
      // status. src/source-guard.test.ts is expected to hit the pattern and to be
      // exempt, so a non-empty stdout here is a real finding.
      expect(r.out.trim()).toBe('')
      expect(r.rc).toBe(0)
    })
  },
)
