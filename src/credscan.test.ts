import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * credscan.sh is the local and CI mirror of the publish-time credential gate, and it
 * SHIPS to the public repo. Its scope therefore has to follow the layout: a fixed
 * pathspec naming `public/` and `docs/*.example.json` scanned almost nothing in the
 * assembled tree, leaving README, SECURITY, CONTRIBUTING, docs/*.md and examples/**
 * unchecked (#64). These cases pin both layouts and the fail-closed paths.
 */
const PAT = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')
const REPO = process.cwd()

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

/** A throwaway git repo carrying a copy of the two scripts under test. */
function repo(layout: 'public' | 'dev'): string {
  const d = mkdtempSync(join(tmpdir(), `credscan-${layout}-`))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  for (const f of ['credscan.sh', 'cred-pattern.sh', 'layout.sh']) {
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f))
  }
  for (const rel of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
    writeFileSync(join(d, rel), `# ${rel}\n`)
  }
  mkdirSync(join(d, 'docs'), { recursive: true })
  mkdirSync(join(d, 'examples'), { recursive: true })
  mkdirSync(join(d, 'src'), { recursive: true })
  writeFileSync(join(d, 'docs', 'SUPPORT.md'), 'support\n')
  writeFileSync(join(d, 'examples', 'tokens.example.json'), '{}\n')
  writeFileSync(join(d, 'src', 'index.ts'), 'export const x = 1\n')
  // The tree DECLARES its layout. It used to be inferred from `existsSync('public')`,
  // so an empty directory of that name switched a public tree to the dev pathspec and
  // the scan reported clean over files it had stopped reading (#107).
  writeFileSync(join(d, '.manyportals-layout'), `${layout}\n`)
  if (layout === 'dev') {
    // The dev tree excludes the two surfaces that legitimately discuss token shapes.
    mkdirSync(join(d, 'public'), { recursive: true })
    writeFileSync(join(d, 'public', 'README.md'), '# public\n')
    mkdirSync(join(d, 'project-docs'), { recursive: true })
    writeFileSync(join(d, 'project-docs', 'notes.md'), `a token looks like ${PAT}\n`)
    writeFileSync(join(d, 'docs', 'API_NOTES.md'), `example: ${PAT}\n`)
  }
  git(d, ['init', '-q', '-b', 'main'])
  git(d, ['add', '-A'])
  return d
}

function scan(dir: string): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/credscan.sh'], {
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

function plant(dir: string, rel: string): void {
  writeFileSync(join(dir, rel), `contents\n${PAT}\n`)
  git(dir, ['add', '-A'])
}

describe('credscan.sh in the assembled public layout', () => {
  let d: string
  beforeAll(() => {
    d = repo('public')
  })

  it('is clean on a tree with no credential literal', () => {
    expect(scan(d).rc).toBe(0)
  })

  it.each([
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'docs/SUPPORT.md',
    'examples/tokens.example.json',
  ])('catches a literal in %s, which the fixed pathspec could not see', (rel) => {
    const t = repo('public')
    plant(t, rel)
    const r = scan(t)
    expect(r.rc).toBe(1)
    expect(r.out).toContain(rel)
    rmSync(t, { recursive: true, force: true })
  })

  it('catches a literal inside a binary file', () => {
    const t = repo('public')
    writeFileSync(
      join(t, 'src', 'blob.bin'),
      Buffer.concat([Buffer.from([0, 0]), Buffer.from(PAT), Buffer.from([0])]),
    )
    git(t, ['add', '-A'])
    expect(scan(t).rc).toBe(1)
    rmSync(t, { recursive: true, force: true })
  })

  it('never echoes the matched line', () => {
    const t = repo('public')
    plant(t, 'README.md')
    expect(scan(t).out).not.toContain(PAT)
    rmSync(t, { recursive: true, force: true })
  })
})

describe('credscan.sh in the dev layout', () => {
  it('ignores project-docs and docs prose, which discuss token shapes on purpose', () => {
    const d = repo('dev')
    expect(scan(d).rc).toBe(0)
  })

  it('still catches a literal in src', () => {
    const d = repo('dev')
    plant(d, 'src/index.ts')
    expect(scan(d).rc).toBe(1)
  })
})

describe('credscan.sh does not let a stray directory pick its scope (#107)', () => {
  it('keeps scanning the public file set after someone creates a directory named public', () => {
    const d = repo('public')
    plant(d, 'docs/SUPPORT.md')
    expect(scan(d).rc).toBe(1)
    // `public/` is one of the most ordinary directory names in the ecosystem, and a
    // contributor to the public repo making one is not an attack. Under the old sniff
    // this single line flipped the run to rc=0 "clean" with the credential untouched.
    mkdirSync(join(d, 'public'), { recursive: true })
    const after = scan(d)
    expect(after.rc).toBe(1)
    expect(after.out).toContain('docs/SUPPORT.md')
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses to run rather than guess when the declaration is missing', () => {
    const d = repo('public')
    plant(d, 'docs/SUPPORT.md')
    rmSync(join(d, '.manyportals-layout'))
    const r = scan(d)
    expect(r.rc).not.toBe(0)
    expect(r.out).toContain('.manyportals-layout')
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses to run rather than guess when the declaration is unrecognised', () => {
    const d = repo('public')
    writeFileSync(join(d, '.manyportals-layout'), 'production\n')
    const r = scan(d)
    expect(r.rc).not.toBe(0)
    expect(r.out).toContain('production')
    rmSync(d, { recursive: true, force: true })
  })
})

describe('credscan.sh fails closed', () => {
  it('exits non-zero when the shared pattern file is missing', () => {
    const d = repo('public')
    plant(d, 'README.md')
    rmSync(join(d, 'scripts', 'cred-pattern.sh'))
    const r = scan(d)
    expect(r.rc).not.toBe(0)
    expect(r.out).toContain('failing closed')
  })

  it('exits non-zero when the shared pattern is empty', () => {
    const d = repo('public')
    plant(d, 'README.md')
    writeFileSync(join(d, 'scripts', 'cred-pattern.sh'), 'CRED=""\n')
    const r = scan(d)
    expect(r.rc).not.toBe(0)
    expect(r.out).toContain('failing closed')
  })
})
