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

function scan(dir: string): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/ref-scan.sh', dir], {
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
