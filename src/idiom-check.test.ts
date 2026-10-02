import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The idiom check is the mechanism engineering-lessons L1 asked for in July and never
 * got: fix the anti-pattern, then sweep for siblings. Every fix in the 2026-09-28
 * review had landed as an edit to the one file that was burned.
 *
 * So every rule here is driven against a file that TRIPS it. The first version of the
 * rule table packed its fields into `|`-delimited strings while every regex contained
 * `|`, and three rules were silently truncated to a fragment matching nothing. They
 * reported clean over eighteen real hits. A rule that has never been made to fire is
 * not evidence of anything, and this file is what stops that recurring (#113).
 */
const REPO = process.cwd()

/** A git repo carrying the real check plus whatever files the case needs. */
function fixture(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'idiom-'))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  mkdirSync(join(d, 'src'), { recursive: true })
  // idiom-check now sources enumerate.sh, so EVERY copy site needs it. Third time this
  // week that adding a dependency to a copied file broke a fixture (L9).
  for (const f of ['idiom-check.sh', 'enumerate.sh']) {
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f))
  }
  // Every rule's globs must match at least one file, or the check fails on a stale
  // glob rather than on the case under test.
  const base: Record<string, string> = {
    'scripts/placeholder.sh': '#!/usr/bin/env bash\necho fine\n',
    // The diagnostic rules name exact paths rather than a glob, so those files must
    // exist in the fixture or every case fails on a stale glob instead of on its rule.
    'src/index.ts': 'export const ok = 1\n',
    'src/doctor/index.ts': 'export const ok = 1\n',
    'src/preflight/index.ts': 'export const ok = 1\n',
    'scripts/placeholder.mjs': 'export const fine = true\n',
    'src/placeholder.ts': 'export const fine = true\n',
    ...files,
  }
  for (const [rel, body] of Object.entries(base)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d, stdio: 'ignore' })
  return d
}

function run(dir: string): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/idiom-check.sh'], {
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

/** One line per rule that MUST trip it. If a rule stops firing, its row fails. */
const TRIPS: Array<[string, string, string]> = [
  ['swallowed-status', 'scripts/bad.sh', 'HITS=$(grep -n x file || true)\n'],
  [
    'silenced-condition',
    'scripts/bad.sh',
    'if grep -r secret "$OUT" >/dev/null 2>&1; then\n  :\nfi\n',
  ],
  ['grep-q-piped', 'scripts/bad.sh', 'unzip -l x.zip | grep -q marker\n'],
  ['grep-skips-binary', 'scripts/bad.sh', 'grep -rIn pattern "$OUT"\n'],
  ['head-in-gate-pipeline', 'scripts/bad.sh', 'git ls-files | head -30\n'],
  ['layout-sniff', 'scripts/bad.sh', 'if [ -d public ]; then\n  :\nfi\n'],
  ['layout-sniff', 'scripts/bad.mjs', "const root = existsSync('public') ? 'public' : '.'\n"],
  ['rc-null-conflated', 'src/bad.test.ts', 'const rc = x.status ?? 1\n'], // idiom-ok: fixture INPUT, it must trip the rule
  ['refusal-outside-the-grammar', 'scripts/bad.sh', 'rc=3\nexit $rc\n'],
  ['existsSync-in-a-diagnostic', 'src/index.ts', 'if (existsSync(p)) return []\n'],
  ['unbound-catch-in-a-diagnostic', 'src/index.ts', 'try { x() } catch { return [] }\n'],
]

describe('every rule can fire', () => {
  it.each(TRIPS)('%s is caught in %s', (id, path, body) => {
    const d = fixture({ [path]: body })
    const r = run(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain(id)
    expect(r.out).toContain(path)
    rmSync(d, { recursive: true, force: true })
  })
})

describe('idiom-check', () => {
  it('passes a tree that holds none of them', () => {
    const d = fixture({})
    const r = run(d)
    expect(r.rc).toBe(0)
    expect(r.out).toContain('clean')
    rmSync(d, { recursive: true, force: true })
  })

  it('does not trip on a COMMENT that discusses an idiom', () => {
    // This project's scripts explain these patterns by name. A check that its own
    // documentation cannot survive gets disabled by whoever hits that next.
    const d = fixture({
      'scripts/bad.sh':
        '# `|| true` here would discard the status\n  # grep -rIn is wrong\necho ok\n',
      'scripts/bad.mjs': "// existsSync('public') was the old sniff\n",
    })
    expect(run(d).rc).toBe(0)
    rmSync(d, { recursive: true, force: true })
  })

  it('accepts a line carrying an explicit reasoned exemption', () => {
    const d = fixture({
      'scripts/bad.sh':
        'git config user.name || true  # idiom-ok: optional value, absence is not an error\n',
    })
    expect(run(d).rc).toBe(0)
    rmSync(d, { recursive: true, force: true })
  })

  it('reports every offending line, not just the first', () => {
    const d = fixture({
      'scripts/bad.sh': 'a || true\nb || true\nc || true\n',
    })
    const r = run(d)
    expect(r.out).toContain('scripts/bad.sh:1')
    expect(r.out).toContain('scripts/bad.sh:2')
    expect(r.out).toContain('scripts/bad.sh:3')
    rmSync(d, { recursive: true, force: true })
  })

  it('fails when a rule matches no files, because a stale glob is a silent rule', () => {
    // Deleting the last file a rule watches would otherwise read as that rule passing.
    const d = mkdtempSync(join(tmpdir(), 'idiom-'))
    mkdirSync(join(d, 'scripts'), { recursive: true })
    for (const f of ['idiom-check.sh', 'enumerate.sh']) {
      copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f))
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d, stdio: 'ignore' })
    const r = run(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('stale')
    rmSync(d, { recursive: true, force: true })
  })

  it('sees a brand-new untracked file, which is when it matters most', () => {
    const d = fixture({ 'scripts/brand-new.sh': 'x || true\n' })
    // Nothing is `git add`ed by the fixture, so this also pins the --others flag.
    expect(run(d).rc).toBe(1)
    rmSync(d, { recursive: true, force: true })
  })
})

/**
 * The detector contained the defect its own rules describe (#126). TWO independent
 * mechanisms, pinned separately, because fixing one does nothing for the other:
 *
 *  A. ENUMERATION. `git ls-files` without `-z` QUOTES a filename containing a newline.
 *     The quoted form is not a path, so `[ -f ]` was false and the file was skipped in
 *     silence, before any scanning happened.
 *  B. READING. `grep -nE ... | grep -v ... | grep -v ...` reports the LAST filter's
 *     status, so a permission error from the scan (rc=2) was masked and an unreadable
 *     file passed as clean. This happens AFTER successful enumeration, so a NUL-safe
 *     enumerator leaves it entirely intact.
 *
 * A and B are `swallowed-status` and `silenced-condition`: the two rules this script
 * enforces. Each case below has a readable, ordinarily-named control, because a check
 * that fails closed on everything is a different defect wearing the same red cross.
 */
describe('idiom-check cannot report clean on something it did not read (#126)', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const VIOLATION = 'echo PORTAL_A || true\n'

  it('CONTROL: catches an ordinary readable violation in an ordinary filename', () => {
    const d = fixture({ 'scripts/bad.sh': VIOLATION })
    expect(run(d).rc).toBe(1)
    rmSync(d, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32' || asRoot)(
    'B: fails closed on the SAME violation when the file cannot be READ',
    () => {
      const d = fixture({ 'scripts/bad.sh': VIOLATION })
      chmodSync(join(d, 'scripts/bad.sh'), 0o000)
      const r = run(d)
      chmodSync(join(d, 'scripts/bad.sh'), 0o644)
      expect(r.rc).toBe(1)
      expect(r.out).toContain('cannot scan')
      rmSync(d, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32' || asRoot)(
    'B: fails closed on an unreadable file that contains NO violation either',
    () => {
      // The status must come from "could not look", not from having found something.
      const d = fixture({ 'scripts/plain.sh': 'echo fine\n' })
      chmodSync(join(d, 'scripts/plain.sh'), 0o000)
      const r = run(d)
      chmodSync(join(d, 'scripts/plain.sh'), 0o644)
      expect(r.rc).toBe(1)
      expect(r.out).toContain('cannot scan')
      rmSync(d, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32')('A: ENUMERATES a filename containing a newline', () => {
    const d = fixture({ 'scripts/we\nird.sh': VIOLATION })
    expect(run(d).rc).toBe(1)
    rmSync(d, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'A: a newline filename with no violation does not fail the run',
    () => {
      // Distinguishes "enumerated it" from "refused because the name was odd".
      const d = fixture({ 'scripts/we\nird.sh': 'echo fine\n' })
      expect(run(d).rc).toBe(0)
      rmSync(d, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'reports a listed path that is not a regular file',
    () => {
      // A DANGLING SYMLINK, not a directory. My first attempt used a directory and the
      // case passed vacuously: `git ls-files` does not list directories, so nothing ever
      // reached the branch. git does track symlinks, so this input actually gets there.
      const d = fixture({})
      symlinkSync('nowhere-at-all', join(d, 'scripts', 'dangling.sh'))
      const r = run(d)
      expect(r.rc).toBe(1)
      expect(r.out).toContain('not a regular file')
      rmSync(d, { recursive: true, force: true })
    },
  )
})
