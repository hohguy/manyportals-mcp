import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * version-check.mjs SHIPS, and it guards the one thing a release edits by hand in three
 * places: package.json, manifest.json and a prose line in the published documents.
 *
 * The prose half is why this exists. A status sentence that must track a mechanical
 * value cannot be diffed against anything, so it drifts silently and a reader takes
 * "as of 0.1.4" as current (#129).
 */
const REPO = process.cwd()

/**
 * version-check.mjs imports layout.mjs, so the fixture needs BOTH. Fifth time a script
 * gained a sibling dependency and every fixture copying it had to follow; the class is
 * #137, and the failure without this is ERR_MODULE_NOT_FOUND from a temporary directory,
 * which reads as the script being broken rather than the fixture being short a file.
 */
function fixture(opts: {
  pkg: string
  manifest: string
  docs?: Record<string, string>
  layout?: string
}): string {
  const d = mkdtempSync(join(tmpdir(), 'vercheck-'))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  for (const f of ['version-check.mjs', 'layout.mjs']) {
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f))
  }
  writeFileSync(join(d, '.manyportals-layout'), `${opts.layout ?? 'public'}\n`)
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version: opts.pkg }, null, 2))
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ version: opts.manifest }, null, 2))
  const docs = opts.docs ?? { 'README.md': '# Doc\n\nPlain text.\n' }
  for (const [rel, body] of Object.entries(docs)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return d
}

function run(dir: string, args: string[] = []): { rc: number; out: string } {
  try {
    const out = execFileSync('node', ['scripts/version-check.mjs', ...args], {
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

describe('version-check', () => {
  it('passes when every surface agrees', () => {
    const r = run(
      fixture({
        pkg: '0.2.0',
        manifest: '0.2.0',
        docs: { 'README.md': 'Documented as of 0.2.0.\n' },
      }),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out).toContain('agrees across')
  })

  it('refuses when the manifest and the package disagree', () => {
    const r = run(fixture({ pkg: '0.2.0', manifest: '0.1.4' }))
    expect(r.rc).toBe(1)
    // Both values named, so the reader does not have to go and look them up.
    expect(r.out).toContain('"0.1.4"')
    expect(r.out).toContain('"0.2.0"')
  })

  it('refuses a stale as-of line in a published document', () => {
    const r = run(
      fixture({
        pkg: '0.2.0',
        manifest: '0.2.0',
        docs: { 'SECURITY.md': 'These are documented rather than fixed, as of 0.1.4.\n' },
      }),
    )
    expect(r.rc).toBe(1)
    expect(r.out).toContain('as of 0.1.4')
  })

  // The row an over-broad rule breaks. A version named as a HISTORICAL threshold is not a
  // status and must not be rewritten every release, which is how a check trains people to
  // ignore it. Only the explicit `as of <x.y.z>` marker is a claim about now.
  it('leaves a historical version reference alone', () => {
    const r = run(
      fixture({
        pkg: '0.2.0',
        manifest: '0.2.0',
        docs: {
          'NOTES.md': 'Required for any build at or after 0.1.2. Since 0.1.4 the two agree.\n',
        },
      }),
    )
    expect(r.rc, r.out).toBe(0)
  })

  // Two distinct faults, kept apart. Collapsing "I could not look" into "there is nothing
  // there" is the defect #111 was about, and the first version of this script did exactly
  // that: a missing root escaped as a stack trace, which exits non-zero by accident
  // rather than by design and hands the operator a crash instead of a reason.
  // The tag is the third surface that can drift, and the only one that cannot be checked
  // from inside the tree: at verify time there is no tag. The release step asks with
  // --tag rather than trusting an eye (#35).
  it('accepts a tag that matches the package version', () => {
    const r = run(fixture({ pkg: '0.2.0', manifest: '0.2.0' }), ['--tag', 'v0.2.0'])
    expect(r.rc, r.out).toBe(0)
  })

  it('refuses a tag that labels a different build', () => {
    const r = run(fixture({ pkg: '0.1.4', manifest: '0.1.4' }), ['--tag', 'v0.2.0'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('does not match package.json 0.1.4')
  })

  it('refuses when the document root cannot be read', () => {
    const r = run(fixture({ pkg: '0.2.0', manifest: '0.2.0', docs: {}, layout: 'dev' }))
    expect(r.rc).toBe(1)
    expect(r.out).toContain('could not read public/')
    expect(r.out).not.toContain('at Object.')
  })

  it('refuses when the root is readable but holds no documents', () => {
    const d = fixture({ pkg: '0.2.0', manifest: '0.2.0', docs: {}, layout: 'dev' })
    mkdirSync(join(d, 'public'), { recursive: true })
    const r = run(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('nothing was checked')
  })
})
