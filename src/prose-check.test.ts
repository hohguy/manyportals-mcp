import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * prose-check.sh SHIPS, and in the assembled public repo it is the only thing
 * enforcing the published-prose rules. Two gaps made it unable to fail there: the
 * file list omitted CONTRIBUTING.md and the issue templates, and it was expanded
 * unquoted so a name containing a space was silently skipped (#68).
 */
const EM_DASH = '—'
const REPO = process.cwd()

/** A throwaway repo in the ASSEMBLED public layout, declared rather than inferred. */
function publicRepo(docs: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'prose-'))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  for (const f of ['prose-check.sh', 'prose-pattern.sh', 'layout.sh', 'enumerate.sh']) {
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f))
  }
  writeFileSync(join(d, '.manyportals-layout'), 'public\n')
  const base: Record<string, string> = {
    'README.md': '# ManyPortals\n\nPlain text.\n',
    'SECURITY.md': '# Security\n\nPlain text.\n',
    'CONTRIBUTING.md': '# Contributing\n\nPlain text.\n',
    'docs/USAGE.md': '# Usage\n\nPlain text.\n',
    'examples/README.md': '# Examples\n\nPlain text.\n',
    '.github/ISSUE_TEMPLATE/bug_report.md': '# Bug\n\nPlain text.\n',
    ...docs,
  }
  for (const [rel, body] of Object.entries(base)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d, stdio: 'ignore' })
  execFileSync('git', ['add', '-A'], { cwd: d, stdio: 'ignore' })
  return d
}

function check(dir: string): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/prose-check.sh'], {
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

describe('prose-check.sh in the public layout', () => {
  it('passes a clean doc set', () => {
    expect(check(publicRepo()).rc).toBe(0)
  })

  it.each([
    ['CONTRIBUTING.md', `# Contributing\n\nA sentence ${EM_DASH} with an em dash.\n`],
    ['.github/ISSUE_TEMPLATE/bug_report.md', `# Bug\n\nA sentence ${EM_DASH} with an em dash.\n`],
  ])('catches an em dash in %s, which was outside the file list', (rel, body) => {
    const r = check(publicRepo({ [rel]: body }))
    expect(r.rc).toBe(1)
    expect(r.out).toContain(rel)
  })

  it('catches a filler phrase in the issue template', () => {
    const r = check(
      publicRepo({ '.github/ISSUE_TEMPLATE/bug_report.md': '# Bug\n\nIn order to report this.\n' }),
    )
    expect(r.rc).toBe(1)
  })

  it('catches a routing claim about every action rather than every write', () => {
    // The sentence that shipped in public/docs/USAGE.md:5. The code routes every WRITE;
    // reads may use the selected default, which is what set_default_read_portal is for.
    const r = check(
      publicRepo({
        'docs/USAGE.md': '# Usage\n\nIt routes every action to the portal you name.\n',
      }),
    )
    expect(r.rc).toBe(1)
    expect(r.out).toContain('docs/USAGE.md')
  })

  it('catches a long-form date in CONTRIBUTING.md', () => {
    const r = check(
      publicRepo({ 'CONTRIBUTING.md': '# Contributing\n\nUpdated 28 September 2026.\n' }),
    )
    expect(r.rc).toBe(1)
  })

  it('scans a document whose name contains a space', () => {
    // Unquoted expansion split this into two nonexistent operands; grep's error was
    // discarded and the check reported clean.
    const r = check(publicRepo({ 'docs/new page.md': `# New\n\nA sentence ${EM_DASH} here.\n` }))
    expect(r.rc).toBe(1)
    expect(r.out).toContain('new page.md')
  })

  it('still catches violations in README.md', () => {
    const r = check(publicRepo({ 'README.md': `# R\n\nA sentence ${EM_DASH} here.\n` }))
    expect(r.rc).toBe(1)
  })
})

/**
 * The three rules used to end in `|| true`, so grep's rc=2 ("I could not read that")
 * was collapsed into rc=1 ("no match"). With the pattern file removed, or one document
 * at mode 000, the run printed Permission denied lines and then "clean prose", rc=0.
 * The sibling scanners had carried the correct three-way handling since #65 and #99
 * and it was never swept here (#108).
 */
describe('prose-check tells "no match" from "could not look" (#108)', () => {
  // chmod 000 does not restrict reading on Windows, so the condition this case exists
  // to create cannot be staged there. The other two fail-closed cases (missing and
  // empty pattern file) run everywhere and cover the same branch.
  it.skipIf(process.platform === 'win32')('fails closed when a document cannot be read', () => {
    const d = publicRepo({ 'docs/USAGE.md': '# Usage\n\nPlain text.\n' })
    chmodSync(join(d, 'docs/USAGE.md'), 0o000)
    const r = check(d)
    chmodSync(join(d, 'docs/USAGE.md'), 0o644)
    expect(r.rc).not.toBe(0)
    expect(r.out).toContain('failing closed')
  })

  it('fails closed when the shared pattern file is missing', () => {
    // Two of the three rules were defined by that file. Without it they stopped
    // existing, and the run still called the prose clean.
    const d = publicRepo({ 'README.md': '# R\n\nIn order to do this.\n' })
    rmSync(join(d, 'scripts', 'prose-pattern.sh'))
    const r = check(d)
    expect(r.rc).not.toBe(0)
    expect(r.out).toContain('failing closed')
  })

  it('fails closed when a pattern is present but empty', () => {
    const d = publicRepo({ 'README.md': '# R\n\nIn order to do this.\n' })
    writeFileSync(join(d, 'scripts', 'prose-pattern.sh'), 'FILLER=""\nDATE_LONGFORM=""\n')
    const r = check(d)
    expect(r.rc).not.toBe(0)
    expect(r.out).toContain('failing closed')
  })

  it('still reports an ordinary violation as a violation, not as an error', () => {
    // A guard that fails closed on everything is a different defect wearing the
    // same green tick.
    const d = publicRepo({ 'README.md': '# R\n\nIn order to do this.\n' })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('filler phrase')
  })
})

/**
 * The doc list came from `< <(git ls-files -z ...)`, whose exit status the loop cannot
 * see. A producer that emits a prefix and dies leaves the rules applied to part of the
 * doc set, and `-gt 0` on the resulting array cannot tell that from a complete run.
 * Measured with a shim: real git FAILED on the planted em dash, truncating git reported
 * clean (#109).
 */
describe('prose-check refuses to report on a partial list (#109)', () => {
  /** A PATH entry whose `git ls-files` emits a prefix and then fails. */
  function truncatingGit(): string {
    const bin = mkdtempSync(join(tmpdir(), 'shim-'))
    // The real git is resolved HERE and baked in as an absolute path. Resolving it
    // inside the shim with `command -v` can find the SHIM, because the shim's own
    // directory is on PATH by the time it runs, and the shim then execs itself
    // forever. That is a spawn loop, not a slow test: it surfaced as a 30s timeout on
    // one CI leg and would have kept surfacing as an intermittent one.
    const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    expect(realGit).not.toBe('')
    writeFileSync(
      join(bin, 'git'),
      `#!/usr/bin/env bash
if [ "$1" = "ls-files" ]; then ${JSON.stringify(realGit)} "$@" | head -c 120; exit 1; fi
exec ${JSON.stringify(realGit)} "$@"
`,
    )
    chmodSync(join(bin, 'git'), 0o755)
    return bin
  }

  it.skipIf(process.platform === 'win32')('fails closed when the enumeration dies partway', () => {
    const d = publicRepo({ 'docs/USAGE.md': `# Usage\n\nA sentence ${EM_DASH} here.\n` })
    // Real git finds the em dash, which is the control: the fixture is genuinely dirty.
    expect(check(d).rc).toBe(1)

    const bin = truncatingGit()
    let rc = 0
    let out: string
    try {
      out = execFileSync('bash', ['scripts/prose-check.sh'], {
        cwd: d,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string }
      rc = typeof x.status === 'number' ? x.status : -1
      out = (x.stdout ?? '') + (x.stderr ?? '')
    }
    expect(rc).not.toBe(0)
    expect(out).toContain('did not complete')
  })
})
