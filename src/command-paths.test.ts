import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * scripts/command-paths.mjs: a shipped command must not name a file that is not shipped.
 *
 * The defect it exists for is #121: the published `ci.yml` ran `bash
 * scripts/publish-sync.sh`, an assembler that is deliberately never published, so the
 * public repository held a CI job that exited 127 on every push. It was invisible for
 * months because the only tree that can answer the question is the assembled one.
 *
 * So every case below is an input that must make the check FAIL, plus the controls that
 * stop "fails on everything" from satisfying them: `bash`, `npm`, `node` and `npx` are
 * external commands and must NOT be flagged, a comment that names a path is not a
 * command that runs it, and a build output is legitimately absent.
 */
const REPO = process.cwd()

const PKG = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts }, null, 2)

/** A tree holding the check, a package.json, and whatever workflows the case needs. */
function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'cmdpaths-'))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  copyFileSync(join(REPO, 'scripts', 'command-paths.mjs'), join(d, 'scripts', 'command-paths.mjs'))
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true })
  if (!('package.json' in files)) files = { 'package.json': PKG({ test: 'vitest run' }), ...files }
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return d
}

function check(dir: string): { rc: number; out: string } {
  try {
    const out = execFileSync('node', ['scripts/command-paths.mjs'], {
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

/** One workflow with the given steps, at the indentation a real workflow uses. */
const workflow = (steps: string) => `name: CI\non:\n  push:\njobs:\n  verify:\n    steps:\n${steps}`

describe('command-paths can fail (#121)', () => {
  it('passes a tree whose commands all name files it holds', () => {
    // The control. Without it, every case below is satisfied by failing on everything.
    const d = tree({
      'package.json': PKG({ 'links:check': 'node scripts/docs-links.mjs' }),
      '.github/workflows/ci.yml': workflow(
        '      - uses: actions/checkout@v5\n      - run: npm ci\n      - run: bash scripts/build.sh\n',
      ),
      'scripts/build.sh': 'echo built\n',
      'scripts/docs-links.mjs': 'console.log(1)\n',
    })
    const r = check(d)
    expect(r.rc).toBe(0)
    expect(r.out).toContain('clean')
    // The extractor found something. "No missing paths" over an empty list is the way
    // this check would stop checking without going red.
    expect(r.out).toMatch(/clean — [1-9]\d* repository-relative path/)
    rmSync(d, { recursive: true, force: true })
  })

  it('catches a workflow step that runs a script the tree does not hold', () => {
    // #121 itself: ci.yml shipped, its assembler did not.
    const d = tree({
      '.github/workflows/ci.yml': workflow(
        '      - run: bash scripts/publish-sync.sh --out "${{ runner.temp }}/check"\n',
      ),
    })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('scripts/publish-sync.sh')
    expect(r.out).toContain('.github/workflows/ci.yml')
    rmSync(d, { recursive: true, force: true })
  })

  it('catches a package.json script that runs a file the tree does not hold', () => {
    // The second half of #121: `verify:publish` named the same absent assembler.
    const d = tree({
      'package.json': PKG({ 'verify:publish': 'bash scripts/publish-sync.sh --out /tmp/x' }),
      '.github/workflows/ci.yml': workflow('      - run: npm ci\n'),
    })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('package.json scripts.verify:publish')
    rmSync(d, { recursive: true, force: true })
  })

  it('reads a run: | block, not only single-line steps', () => {
    // The layout job's identity step is a block scalar, so a parser that handled only
    // inline commands would have skipped the job that held the defect.
    const d = tree({
      '.github/workflows/ci.yml': workflow(
        '      - run: |\n          npm ci\n          bash scripts/gone.mjs\n',
      ),
    })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('scripts/gone.mjs')
    rmSync(d, { recursive: true, force: true })
  })

  it('does not flag bash, npm, node or npx, which are not in any tree', () => {
    // The scoping the review asked for: only repository-relative paths are checked.
    // `scripts/ok.sh` is the positive control INSIDE this case: it proves the extractor
    // was awake while it declined to flag the external commands beside it.
    const d = tree({
      'package.json': PKG({
        build: 'npm run clean && tsc -p tsconfig.build.json',
        clean: "node -e \"require('fs').rmSync('build', { recursive: true })\"",
        x: 'npx vitest run',
        ok: 'bash scripts/ok.sh',
      }),
      '.github/workflows/ci.yml': workflow(
        '      - run: npm ci\n      - run: bash -c "echo hi"\n      - run: git config --local user.name "CI"\n',
      ),
      'scripts/ok.sh': 'echo ok\n',
    })
    const r = check(d)
    expect(r.rc).toBe(0)
    expect(r.out).toMatch(/clean — 1 repository-relative path/)
    rmSync(d, { recursive: true, force: true })
  })

  it('does not flag a path that only appears in a comment inside a run: block', () => {
    // A file that DESCRIBES a path must not trip the check that enforces it, which is
    // the same reason idiom-check.sh strips comment lines before scanning. The resolvable
    // step is the positive control: the extractor ran and found that one.
    const d = tree({
      'package.json': PKG({ ok: 'bash scripts/ok.sh' }),
      '.github/workflows/ci.yml': workflow(
        '      # see scripts/publish-sync.sh\n      - run: |\n          # the assembler lives at scripts/publish-sync.sh and is private\n          npm ci\n',
      ),
      'scripts/ok.sh': 'echo ok\n',
    })
    const r = check(d)
    expect(r.rc).toBe(0)
    expect(r.out).toMatch(/clean — 1 repository-relative path/)
    rmSync(d, { recursive: true, force: true })
  })

  it('does not flag a build output, which the build writes later in the same run', () => {
    const d = tree({
      'package.json': PKG({
        build: "node -e \"require('fs').chmodSync('dist/index.js')\"",
        ok: 'bash scripts/ok.sh',
      }),
      '.github/workflows/ci.yml': workflow('      - run: npm ci\n'),
      'scripts/ok.sh': 'echo ok\n',
    })
    const r = check(d)
    expect(r.rc).toBe(0)
    expect(r.out).toContain('dist/index.js')
    expect(r.out).toContain('generated by the build')
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses a workflow directory with no run: step rather than reporting clean', () => {
    // "Every path named by no command exists" is true and worthless. A check must not be
    // satisfiable by removing its own input.
    const d = tree({
      '.github/workflows/ci.yml': 'name: CI\non:\n  push:\njobs:\n  verify:\n    steps:\n',
    })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('no run: step')
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses a tree whose commands name no repository path at all', () => {
    // The other way this check could stop checking: an extractor that matches nothing
    // reports every tree clean. It must say so instead of passing.
    const d = tree({
      'package.json': PKG({ x: 'npx vitest run' }),
      '.github/workflows/ci.yml': workflow('      - run: npm ci\n'),
    })
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('broken extractor')
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses a tree with no workflow files at all', () => {
    const d = mkdtempSync(join(tmpdir(), 'cmdpaths-'))
    mkdirSync(join(d, 'scripts'), { recursive: true })
    copyFileSync(
      join(REPO, 'scripts', 'command-paths.mjs'),
      join(d, 'scripts', 'command-paths.mjs'),
    )
    writeFileSync(join(d, 'package.json'), PKG({ test: 'vitest run' }))
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('.github/workflows')
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses a directory standing in for an executable', () => {
    const d = tree({
      '.github/workflows/ci.yml': workflow('      - run: bash scripts/build.sh\n'),
    })
    mkdirSync(join(d, 'scripts', 'build.sh'))
    const r = check(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('not a regular file')
    rmSync(d, { recursive: true, force: true })
  })
})
