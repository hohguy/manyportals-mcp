import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * cred-scan-tree.sh is the leak gate over the assembled public tree. Its whole
 * interface is the exit status, because the caller used to swallow "I could not
 * read the tree" and report clean (#65). Each case below is a firing input.
 */
function scan(dir: string, args: string[] = []): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/cred-scan-tree.sh', dir, ...args], {
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

// Assembled from parts so this test file is not itself a credential-shaped literal
// that the repo's own scanners would flag.
const PAT = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')

function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'credtree-'))
  mkdirSync(join(d, 'sub'), { recursive: true })
  writeFileSync(join(d, 'sub', 'a.txt'), 'nothing to see\n')
  return d
}

describe('cred-scan-tree.sh', () => {
  it('exits 0 on a clean tree', () => {
    expect(scan(fixture()).rc).toBe(0)
  })

  it('exits 1 and names the file when a real-shaped PAT is present', () => {
    const d = fixture()
    writeFileSync(join(d, 'sub', 'leak.txt'), `${PAT}\n`)
    const r = scan(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('leak.txt')
  })

  it('exits 1 for a PAT hidden inside a binary file', () => {
    // `-a` rather than `-I`: a token in a binary asset must not pass unseen.
    const d = fixture()
    writeFileSync(
      join(d, 'sub', 'bin.dat'),
      Buffer.concat([Buffer.from([0, 0]), Buffer.from(PAT), Buffer.from([0])]),
    )
    const r = scan(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('bin.dat')
  })

  it('exits 1 on a PEM private-key header', () => {
    const d = fixture()
    // Assembled from parts for the same reason PAT is: a contiguous literal here
    // would make this file itself a credential-shaped surface, and the repo's own
    // gates would refuse to publish src/ (which is exactly what happened).
    const PEM = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
    writeFileSync(join(d, 'sub', 'k.pem'), `${PEM}\n`)
    const r = scan(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('k.pem')
  })

  it('never prints the matched line, only the file name', () => {
    const d = fixture()
    writeFileSync(join(d, 'sub', 'leak.txt'), `token is ${PAT} ok\n`)
    const r = scan(d)
    expect(r.rc).toBe(1)
    expect(r.out).not.toContain(PAT)
  })

  it.skipIf(process.platform === 'win32')(
    'exits 2 rather than 0 when part of the tree cannot be read',
    () => {
      // The #65 defect: grep exits 2, `|| true` turned that into "no hits found".
      const d = fixture()
      writeFileSync(join(d, 'sub', 'leak.txt'), `${PAT}\n`)
      chmodSync(join(d, 'sub'), 0o000)
      const r = scan(d)
      chmodSync(join(d, 'sub'), 0o755)
      expect(r.rc).toBe(2)
      expect(r.out).toContain('failing closed')
    },
  )

  it('exits 2 on a missing directory and on no argument', () => {
    const missing = scan(join(tmpdir(), 'credtree-no-such-dir'))
    expect(missing.rc).toBe(2)
    expect(missing.out).toContain('not a directory')
    try {
      execFileSync('bash', ['scripts/cred-scan-tree.sh'], { stdio: ['ignore', 'pipe', 'pipe'] })
      throw new Error('expected a non-zero exit')
    } catch (e) {
      expect((e as { status?: number }).status).toBe(2)
    }
  })

  it.each([
    ['missing', null],
    ['empty', 'CRED=""\n'],
  ])('exits 2 when the shared pattern file is %s', (_label, contents) => {
    // Deleting or emptying cred-pattern.sh used to leave $CRED unbound, match
    // nothing, and report a clean tree: a guard whose absence read as a pass.
    const bin = mkdtempSync(join(tmpdir(), 'credbin-'))
    mkdirSync(bin, { recursive: true })
    copyFileSync('scripts/cred-scan-tree.sh', join(bin, 'cred-scan-tree.sh'))
    if (contents !== null) writeFileSync(join(bin, 'cred-pattern.sh'), contents)
    const d = fixture()
    writeFileSync(join(d, 'sub', 'leak.txt'), `${PAT}\n`)
    let rc = 0
    let out = ''
    try {
      execFileSync('bash', [join(bin, 'cred-scan-tree.sh'), d], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      const x = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
      rc = typeof x.status === 'number' ? x.status : -1
      out = String(x.stdout ?? '') + String(x.stderr ?? '')
    }
    expect(rc).toBe(2)
    expect(out).toContain('failing closed')
  })

  it('does not match the tokenish test fixtures this repo uses on purpose', () => {
    const d = fixture()
    writeFileSync(
      join(d, 'sub', 'fixtures.ts'),
      'const a = "pat-na1-SECRET"; const b = "pat-na1-abc123"\n',
    )
    expect(scan(d).rc).toBe(0)
  })
})

/**
 * `--exclude-dir` exists so build-mcpb.sh can skip node_modules without keeping a
 * SECOND copy of this scan. That copy is where #108 M1 lived: it never received the
 * rc=2 handling this file has had since #65, so an unreadable path let the bundle pack
 * with a credential in it. One scanner, one tested status contract.
 */
describe('--exclude-dir', () => {
  function treeWithVendor(): string {
    const d = mkdtempSync(join(tmpdir(), 'credex-'))
    mkdirSync(join(d, 'vendor'), { recursive: true })
    writeFileSync(join(d, 'vendor', 'dep.js'), `const t = '${PAT}'\n`)
    writeFileSync(join(d, 'ours.js'), 'const t = 1\n')
    return d
  }

  it('finds a credential in the excluded directory when it is NOT excluded', () => {
    const d = treeWithVendor()
    const r = scan(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('vendor')
  })

  it('skips it when it is', () => {
    const d = treeWithVendor()
    expect(scan(d, ['--exclude-dir=vendor']).rc).toBe(0)
  })

  it('still finds one OUTSIDE the excluded directory', () => {
    // An exclusion that quietly widened to the whole tree would read as clean.
    const d = treeWithVendor()
    writeFileSync(join(d, 'ours.js'), `const t = '${PAT}'\n`)
    const r = scan(d, ['--exclude-dir=vendor'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('ours.js')
  })

  it('refuses an argument it does not recognise, rather than passing it to grep', () => {
    const d = treeWithVendor()
    const r = scan(d, ['--include=*.js'])
    expect(r.rc).toBe(2)
    expect(r.out).toContain('unknown argument')
  })
})
