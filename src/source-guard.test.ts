import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The assembler's copy step is the one place where being wrong publishes a private
 * document, so its decision lives in a pure function and is driven here directly.
 *
 * The defect (#106 H1, verified independently by three reviewers): the step refused a
 * symlinked LEAF, then required the resolved PARENT to sit somewhere under the dev
 * root. `project-docs/` is under the dev root. A committed
 * `public/examples -> ../project-docs/PORTAL_A` resolved inside the repo, passed both
 * tests, and published a private document as `examples/README.md`. The audit that runs
 * afterwards is a blocklist of private NAMES, and the file had arrived under an
 * allowlisted name, so it reported clean.
 */
const REPO = process.cwd()

function assertDeclared(devRoot: string, rel: string): { rc: number; out: string } {
  try {
    const out = execFileSync(
      'bash',
      [
        '-c',
        `source "${REPO}/scripts/source-guard.sh"; source_assert_declared "$1" "$2"`,
        '_',
        devRoot,
        rel,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { rc: 0, out }
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string }
    return {
      rc: typeof x.status === 'number' ? x.status : -1,
      out: (x.stdout ?? '') + (x.stderr ?? ''),
    }
  }
}

/** A miniature dev repo: a public doc set, a private tree, and a build directory. */
function devRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'srcguard-')))
  mkdirSync(join(d, 'public', 'examples'), { recursive: true })
  mkdirSync(join(d, 'project-docs', 'PORTAL_A'), { recursive: true })
  mkdirSync(join(d, 'src'), { recursive: true })
  writeFileSync(join(d, 'public', 'examples', 'README.md'), '# Examples\n')
  writeFileSync(join(d, 'project-docs', 'PORTAL_A', 'README.md'), 'private notes\n')
  writeFileSync(join(d, 'src', 'index.ts'), 'export const x = 1\n')
  return d
}

/**
 * POSIX only. The guard compares `cd "$(dirname)" && pwd -P` against the declared
 * path, and under Git Bash on Windows those are different spellings of the same place
 * (`/c/Users/...` versus `C:\\Users\\...`), so it refuses every file. That is the safe
 * direction and matches the decision on prepublish-guard: assembly happens from a
 * maintainer's POSIX machine. Tracked on #96.
 */
describe.skipIf(process.platform === 'win32')('source_assert_declared', () => {
  it('accepts an ordinary allowlisted file', () => {
    const d = devRepo()
    expect(assertDeclared(d, 'public/examples/README.md').rc).toBe(0)
    expect(assertDeclared(d, 'src/index.ts').rc).toBe(0)
    rmSync(d, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses the private tree reached through a symlinked path COMPONENT',
    () => {
      const d = devRepo()
      // The reviewer's input, exactly: an allowlisted name whose directory is a
      // symlink into the private tree. Both the old tests passed on this.
      rmSync(join(d, 'public', 'examples'), { recursive: true, force: true })
      symlinkSync('../project-docs/PORTAL_A', join(d, 'public', 'examples'))
      const r = assertDeclared(d, 'public/examples/README.md')
      expect(r.rc).toBe(1)
      expect(r.out).toContain('project-docs')
      rmSync(d, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked component even when the destination is innocent',
    () => {
      // The rule is equality with the declared path, not a list of forbidden
      // destinations. A guard that only knows the names it must refuse cannot refuse
      // the name nobody thought of, which is the whole reason this is not a blocklist.
      const d = devRepo()
      mkdirSync(join(d, 'elsewhere'), { recursive: true })
      writeFileSync(join(d, 'elsewhere', 'README.md'), '# harmless\n')
      rmSync(join(d, 'public', 'examples'), { recursive: true, force: true })
      symlinkSync('../elsewhere', join(d, 'public', 'examples'))
      expect(assertDeclared(d, 'public/examples/README.md').rc).toBe(1)
      rmSync(d, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked leaf, which resolving the parent cannot see',
    () => {
      const d = devRepo()
      symlinkSync(join(d, 'project-docs', 'PORTAL_A', 'README.md'), join(d, 'src', 'notes.ts'))
      const r = assertDeclared(d, 'src/notes.ts')
      expect(r.rc).toBe(1)
      expect(r.out).toContain('symlink')
      rmSync(d, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink that leaves the repository entirely',
    () => {
      const d = devRepo()
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')))
      writeFileSync(join(outside, 'README.md'), 'secret\n')
      rmSync(join(d, 'public', 'examples'), { recursive: true, force: true })
      symlinkSync(outside, join(d, 'public', 'examples'))
      expect(assertDeclared(d, 'public/examples/README.md').rc).toBe(1)
      rmSync(d, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    },
  )

  it('refuses a path that is not there at all', () => {
    const d = devRepo()
    const r = assertDeclared(d, 'public/examples/NOPE.md')
    expect(r.rc).toBe(1)
    expect(r.out).toContain('missing')
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses a directory, which cp would not copy by value anyway', () => {
    const d = devRepo()
    expect(assertDeclared(d, 'public/examples').rc).toBe(1)
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses when it is not told both a root and a path', () => {
    const d = devRepo()
    expect(assertDeclared(d, '').rc).toBe(1)
    expect(assertDeclared('', 'src/index.ts').rc).toBe(1)
    rmSync(d, { recursive: true, force: true })
  })
})
