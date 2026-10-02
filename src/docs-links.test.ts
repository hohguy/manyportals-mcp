import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The last gate in COVERAGE_DEBT with no coverage at all (#117).
 *
 * It exists because a documentation reorganisation renamed headings and silently broke
 * seven links in four files. A link checker that has only ever run against documents
 * whose links all resolve is indistinguishable from one that reports nothing, which is
 * the class this project spent the week removing, so every case below is an input that
 * must make it FAIL.
 */
const REPO = process.cwd()

/** A tree in the assembled public layout, which is the simpler of the two it handles. */
function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'docslinks-'))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  for (const f of ['docs-links.mjs', 'layout.mjs']) {
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f))
  }
  writeFileSync(join(d, '.manyportals-layout'), 'public\n')
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return d
}

function check(dir: string): { rc: number; out: string } {
  try {
    const out = execFileSync('node', ['scripts/docs-links.mjs'], {
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

describe('docs-links can fail (#117)', () => {
  it('passes a tree whose links all resolve', () => {
    // The control. Without it, every case below is satisfied by failing on everything.
    const d = tree({
      'README.md':
        '# Home\n\nSee [usage](docs/USAGE.md) and [the part below](#a-section).\n\n## A section\n\ntext\n',
      'docs/USAGE.md': '# Usage\n\nBack to [home](../README.md).\n',
    })
    const r = check(d)
    expect(r.rc).toBe(0)
    expect(r.out).toContain('clean')
    rmSync(d, { recursive: true, force: true })
  })

  it('catches a link to a file that does not exist', () => {
    const d = tree({ 'README.md': '# Home\n\n[gone](docs/MISSING.md)\n' })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('MISSING.md')
    rmSync(d, { recursive: true, force: true })
  })

  it('catches an #anchor that matches no heading in the target file', () => {
    const d = tree({
      'README.md': '# Home\n\n[there](docs/USAGE.md#no-such-heading)\n',
      'docs/USAGE.md': '# Usage\n\n## A real heading\n',
    })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('no-such-heading')
    rmSync(d, { recursive: true, force: true })
  })

  it('catches a bare #anchor that matches no heading in the SAME file', () => {
    // Skipping these certified them falsely, which is why they are checked at all.
    const d = tree({ 'README.md': '# Home\n\n[below](#not-here)\n\n## Something else\n' })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('not-here')
    rmSync(d, { recursive: true, force: true })
  })

  it('catches a link that points at a DIRECTORY rather than a file', () => {
    const d = tree({ 'README.md': '# Home\n\n[docs](docs)\n', 'docs/USAGE.md': '# Usage\n' })
    expect(check(d).rc).toBe(1)
    rmSync(d, { recursive: true, force: true })
  })

  it('leaves external and root-relative links alone, which are out of scope', () => {
    const d = tree({
      'README.md':
        '# Home\n\n[ext](https://example.com/nope) [mail](mailto:a@example.com) [abs](/not/checked)\n',
    })
    expect(check(d).rc).toBe(0)
    rmSync(d, { recursive: true, force: true })
  })

  it('has documents to examine at all', () => {
    // An empty file list makes "every link resolves" true and meaningless.
    const d = tree({ 'README.md': '# Home\n\ntext\n' })
    expect(check(d).out).toMatch(/in [1-9]\d* document/)
    rmSync(d, { recursive: true, force: true })
  })
})
