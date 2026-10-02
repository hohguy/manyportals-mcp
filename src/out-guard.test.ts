import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * publish-sync.sh WIPES its staging directory, so the guard that vets that path
 * cannot be tested by running publish-sync: a regression would delete the thing
 * under test. scripts/out-guard.sh holds the decision and nothing destructive,
 * which is what makes these cases runnable (#62).
 */
type Run = { rc: number; out: string; err: string }

function sh(fn: string, args: string[]): Run {
  try {
    const out = execFileSync(
      'bash',
      ['-c', `source scripts/out-guard.sh; ${fn} "$@"`, '_', ...args],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return { rc: 0, out: out.trim(), err: '' }
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string }
    return {
      rc: typeof x.status === 'number' ? x.status : -1,
      out: (x.stdout ?? '').trim(),
      err: (x.stderr ?? '').trim(),
    }
  }
}
const normalize = (raw: string): Run => sh('out_normalize', [raw])
const assertSafe = (out: string, devRoot: string, home: string): Run =>
  sh('out_assert_safe', [out, devRoot, home])

const HOME = '/Users/operator'
const DEV = '/Users/operator/code/manyportals-mcp'

describe('out_normalize', () => {
  it('does not re-introduce a doubled slash for a depth-1 path', () => {
    // `cd / && pwd -P` prints `/`, so reassembly used to yield `//Users`, which
    // made the ancestor patterns below unable to match (#62).
    expect(normalize('/Users').out).toBe('/Users')
    expect(normalize('/tmp').out).toBe('/tmp')
  })

  it('collapses repeated and trailing slashes', () => {
    expect(normalize('/tmp///').out).toBe('/tmp')
    expect(normalize('//tmp').out).toBe('/tmp')
  })

  it('refuses a relative path, and root or empty', () => {
    expect(normalize('src').rc).toBe(1)
    expect(normalize('/').rc).toBe(1)
    expect(normalize('///').rc).toBe(1)
    expect(normalize('').rc).toBe(1)
  })

  it('refuses a path whose parent does not exist', () => {
    expect(normalize('/no/such/parent/staging').rc).toBe(1)
  })

  // Windows has no POSIX absolute paths, so mkdtemp yields C:\... and the guard
  // correctly refuses it. publish-sync.sh is a POSIX maintainer script; the other
  // cases here use synthetic paths and still run everywhere.
  it.skipIf(process.platform === 'win32')('keeps a legitimate deep staging path usable', () => {
    const parent = mkdtempSync(join(tmpdir(), 'og-'))
    const target = join(parent, 'manyportals-public')
    const r = normalize(target)
    expect(r.rc).toBe(0)
    expect(r.out.endsWith('/manyportals-public')).toBe(true)
    expect(r.out).not.toMatch(/\/\//)
    expect(assertSafe(r.out, DEV, HOME).rc).toBe(0)
  })

  // The leaf used to be re-attached by `basename` after the PARENT was canonicalised,
  // so a `.` or `..` component survived normalization and the assertions then compared
  // a string that did not denote what it named. `<home>/.` is HOME and `<home>/..` is
  // the directory holding every account; both were accepted (#106).
  it.skipIf(process.platform === 'win32')(
    'resolves a dot leaf, so it cannot denote one place and be compared as another',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'oghome-'))
      const real = normalize(home).out

      const dot = normalize(`${home}/.`)
      expect(dot.rc).toBe(0)
      expect(dot.out).toBe(real)
      expect(assertSafe(dot.out, DEV, real).rc).toBe(1)

      const dotdot = normalize(`${home}/..`)
      expect(dotdot.rc).toBe(0)
      expect(dotdot.out).not.toContain('..')
      // It now names the directory ABOVE home, so the ancestor-of-HOME rule fires.
      expect(assertSafe(dotdot.out, DEV, real).rc).toBe(1)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'resolves an interior dot-dot the same way it always did',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'og-'))
      const r = normalize(`${parent}/sub/../manyportals-public`)
      // The parent must exist, and `<parent>/sub/..` does not, so this is refused
      // before canonicalisation. Pinned so the leaf change is not read as a licence
      // to invent directories.
      expect(r.rc).toBe(1)
    },
  )
})

describe('out_assert_safe', () => {
  it('refuses an ancestor of HOME even when the repo lives outside HOME', () => {
    // The case that motivated the extraction: `rm -rf /Users` takes every account.
    // The repo is on another volume here, so the dev-repo guards cannot fire and
    // only the HOME-ancestor check stands between this input and the rm.
    const r = assertSafe('/Users', '/Volumes/work/manyportals-mcp', HOME)
    expect(r.rc).toBe(1)
    expect(r.err).toMatch(/ANCESTOR of HOME/)
  })

  it('refuses a depth-1 ancestor end to end, normalize then assert', () => {
    // #62: normalize used to hand back `//Users`, which no pattern here matched.
    const n = normalize('/Users')
    expect(n.out).toBe('/Users')
    expect(assertSafe(n.out, DEV, HOME).rc).toBe(1)
  })

  it('refuses an ancestor of the dev repo', () => {
    const r = assertSafe('/Users/operator/code', DEV, HOME)
    expect(r.rc).toBe(1)
    expect(r.err).toMatch(/ANCESTOR of the dev repo/)
  })

  it('refuses the dev repo itself and its descendants', () => {
    expect(assertSafe(DEV, DEV, HOME).rc).toBe(1)
    expect(assertSafe(`${DEV}/staging`, DEV, HOME).rc).toBe(1)
  })

  it('refuses HOME, root and empty', () => {
    expect(assertSafe(HOME, DEV, HOME).rc).toBe(1)
    expect(assertSafe('/', DEV, HOME).rc).toBe(1)
    expect(assertSafe('', DEV, HOME).rc).toBe(1)
  })

  it('refuses an unnormalized path rather than comparing it', () => {
    // Belt and braces: if normalization ever regresses, the patterns below stop
    // meaning what they look like, so refuse instead of matching.
    const r = assertSafe('//Users', DEV, HOME)
    expect(r.rc).toBe(1)
    expect(r.err).toMatch(/not normalized/)
  })

  it('accepts a sibling of the dev repo and a path outside HOME', () => {
    expect(assertSafe('/Users/operator/code/staging', DEV, HOME).rc).toBe(0)
    expect(assertSafe('/private/tmp/manyportals-public', DEV, HOME).rc).toBe(0)
  })
})
