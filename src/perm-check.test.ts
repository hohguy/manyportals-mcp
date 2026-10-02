import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * perm-check.sh is the gate that stops synced-volume mode drift reaching the
 * public git tree and the npm tarball (#67). These cases exist so the gate can be
 * shown to FAIL: a mode check that has only ever run against a compliant tree is
 * indistinguishable from one that reports nothing.
 */
function run(args: string[]): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/perm-check.sh', ...args], {
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

function tree(files: Array<[string, number]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'perm-'))
  for (const [rel, mode] of files) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, 'x')
    chmodSync(abs, mode)
  }
  return dir
}

// perm-check deliberately no-ops where POSIX permission bits do not exist, so these
// cases cannot fail there and must not pretend to run.
describe.skipIf(process.platform === 'win32')('perm-check.sh --tree', () => {
  it('passes a tree whose files are all 0644', () => {
    const d = tree([
      ['README.md', 0o644],
      ['docs/USAGE.md', 0o644],
      ['src/index.ts', 0o644],
    ])
    expect(run(['--tree', d]).rc).toBe(0)
  })

  it('fails a group-writable or world-writable file', () => {
    const d = tree([
      ['README.md', 0o644],
      ['docs/USAGE.md', 0o664],
    ])
    const r = run(['--tree', d])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('docs/USAGE.md')
  })

  it('fails a world-writable and executable file', () => {
    const d = tree([['src/index.ts', 0o777]])
    expect(run(['--tree', d]).rc).toBe(1)
  })

  it('fails the drift this machine actually produces, 0700', () => {
    // 104 of 141 tracked files were found at 0700 on the synced volume. The exec
    // bit is what a fresh `git add` in staging records as 100755.
    const d = tree([['package.json', 0o700]])
    const r = run(['--tree', d])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('700')
  })

  it('fails a file that is supposed to be executable but is not', () => {
    const d = tree([['scripts/build-mcpb.sh', 0o644]])
    const r = run(['--tree', d])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('want 755')
  })

  it('accepts the one file that is supposed to be executable', () => {
    const d = tree([
      ['scripts/build-mcpb.sh', 0o755],
      ['README.md', 0o644],
    ])
    expect(run(['--tree', d]).rc).toBe(0)
  })

  it('--fix normalizes a drifted tree and then reports clean', () => {
    const d = tree([
      ['README.md', 0o700],
      ['docs/USAGE.md', 0o666],
    ])
    const r = run(['--fix', '--tree', d])
    expect(r.rc).toBe(0)
    expect(statSync(join(d, 'README.md')).mode & 0o777).toBe(0o644)
    expect(statSync(join(d, 'docs/USAGE.md')).mode & 0o777).toBe(0o644)
  })

  it('fails closed on a directory that does not exist', () => {
    expect(run(['--tree', join(tmpdir(), 'perm-check-no-such-dir')]).rc).toBe(1)
  })
})

/**
 * The stat dialect (CI, 2026-09-28). GNU's `stat -f` means "file system status", not
 * a format string, so a BSD-first probe SUCCEEDED on Linux and returned a multi-line
 * filesystem block. Every file then compared unequal to its expected mode: 149
 * violations on a clean checkout, while the `||` fallback never ran because nothing
 * had failed. macOS passed, so only CI could see it.
 *
 * These cases run the script against a shimmed `stat` so the other platform's
 * semantics can be exercised from either one.
 */
describe.skipIf(process.platform === 'win32')('perm-check.sh stat dialect', () => {
  /** A PATH directory whose `stat` behaves like the named implementation. */
  function shim(kind: 'gnu' | 'bsd' | 'useless'): string {
    const bin = mkdtempSync(join(tmpdir(), `statshim-${kind}-`))
    const real =
      'python3 -c "import os,sys;print(format(os.stat(sys.argv[1]).st_mode & 0o777, \'03o\'))" "$1"'
    const body =
      kind === 'useless'
        ? '#!/usr/bin/env bash\nexit 1\n'
        : kind === 'gnu'
          ? `#!/usr/bin/env bash
case "\${1:-}" in
  -c) shift 2; ${real}; exit $? ;;
  -f) printf '  File: "%s"\\n    ID: abc Namelen: 255     Type: ext2/ext3\\n' "\${3:-.}"; exit 0 ;;
  *) exit 1 ;;
esac
`
          : `#!/usr/bin/env bash
case "\${1:-}" in
  -f) shift 2; ${real}; exit $? ;;
  *) exit 1 ;;
esac
`
    writeFileSync(join(bin, 'stat'), body)
    chmodSync(join(bin, 'stat'), 0o755)
    return bin
  }

  function runWith(bin: string, args: string[]): { rc: number; out: string } {
    try {
      const out = execFileSync('bash', ['scripts/perm-check.sh', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
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

  it.each(['gnu', 'bsd'] as const)('reads real modes under %s stat semantics', (kind) => {
    const d = tree([
      ['README.md', 0o644],
      ['src/index.ts', 0o644],
      ['scripts/build-mcpb.sh', 0o755],
    ])
    expect(runWith(shim(kind), ['--tree', d]).rc).toBe(0)
  })

  it.each(['gnu', 'bsd'] as const)('still catches a bad mode under %s stat semantics', (kind) => {
    const d = tree([
      ['README.md', 0o644],
      ['src/index.ts', 0o666],
    ])
    const r = runWith(shim(kind), ['--tree', d])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('src/index.ts')
  })

  it('fails closed when no stat dialect works, rather than passing everything', () => {
    const d = tree([['README.md', 0o644]])
    const r = runWith(shim('useless'), ['--tree', d])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('failing closed')
  })
})

/**
 * A loop reading `< <(producer)` cannot see the producer's exit status, and `set -e`
 * cannot either. So an unreadable subdirectory made `find` print Permission denied and
 * exit non-zero while the loop went on to certify the files it HAD reached, and running
 * outside a git repository examined zero files and still asserted that every file
 * carries its expected mode. This gate guards the public git tree and the npm tarball,
 * so it was certifying a tree it had not read (#109).
 */
describe('perm-check refuses to report on a partial list (#109)', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

  it.skipIf(process.platform === 'win32' || asRoot)(
    'fails closed when part of the tree cannot be read',
    () => {
      const d = mkdtempSync(join(tmpdir(), 'permenum-'))
      mkdirSync(join(d, 'locked'), { recursive: true })
      const hidden = join(d, 'locked', 'loose.txt')
      writeFileSync(hidden, 'x\n')
      chmodSync(hidden, 0o777) // a real violation, inside the part that cannot be read
      chmodSync(join(d, 'locked'), 0o000)
      const r = run(['--tree', d])
      chmodSync(join(d, 'locked'), 0o755)
      expect(r.rc).not.toBe(0)
      expect(r.out).toContain('did not complete')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'fails closed when there is no git repository to enumerate',
    () => {
      const d = mkdtempSync(join(tmpdir(), 'permenum-'))
      mkdirSync(join(d, 'scripts'), { recursive: true })
      for (const f of ['perm-check.sh', 'enumerate.sh']) {
        copyFileSync(join(process.cwd(), 'scripts', f), join(d, 'scripts', f))
      }
      let rc = 0
      let out: string
      try {
        out = execFileSync('bash', ['scripts/perm-check.sh'], {
          cwd: d,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        const x = e as { status?: number; stdout?: string; stderr?: string }
        rc = typeof x.status === 'number' ? x.status : -1
        out = (x.stdout ?? '') + (x.stderr ?? '')
      }
      expect(rc).not.toBe(0)
      expect(out).toContain('did not complete')
    },
  )

  it('still passes a tree it can read completely', () => {
    // A guard that fails closed on everything is a different defect wearing the
    // same red cross.
    const d = tree([['ok.txt', 0o644]])
    expect(run(['--tree', d]).rc).toBe(0)
  })
})
