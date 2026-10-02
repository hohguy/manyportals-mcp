import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * enumerate.sh cleans up after itself, and used to claim it did without doing it.
 *
 * `enum_tempfile` appended to the cleanup array, but every caller invokes it in a
 * command substitution — `TMP="$(enum_tempfile)"` — so the append happened in a subshell
 * and the parent's EXIT trap read an empty array. Roughly ten thousand `mp-enum.*` files
 * accumulated in one working session, because the guard register runs the whole test
 * suite once per registered mutation (#128).
 *
 * Each case runs the caller with its OWN TMPDIR. Counting `mp-enum.*` in the real
 * temporary directory would pass or fail on files this suite did not create.
 */
const REPO = process.cwd()

/** A throwaway tree holding enumerate.sh, plus an isolated TMPDIR to count in. */
function fixture(): { dir: string; tmp: string } {
  const dir = mkdtempSync(join(tmpdir(), 'enum-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(join(REPO, 'scripts/enumerate.sh'), join(dir, 'scripts/enumerate.sh'))
  const tmp = mkdtempSync(join(tmpdir(), 'enum-tmp-'))
  return { dir, tmp }
}

/** Run a caller in the fixture, and report what it left behind in its own TMPDIR. */
function leftBehind(dir: string, tmp: string, body: string): { rc: number; files: string[] } {
  let rc = 0
  try {
    execFileSync('bash', ['-c', `. scripts/enumerate.sh\n${body}`], {
      cwd: dir,
      env: { ...process.env, TMPDIR: tmp },
      stdio: 'ignore',
    })
  } catch (e) {
    rc = (e as { status?: number }).status ?? -1
  }
  return { rc, files: readdirSync(tmp).filter((f) => f.startsWith('mp-enum.')) }
}

describe.skipIf(process.platform === 'win32')('enumerate.sh cleans up its temporary files', () => {
  it('leaves nothing behind after a normal enumeration', () => {
    const { dir, tmp } = fixture()
    const r = leftBehind(
      dir,
      tmp,
      'T="$(enum_tempfile)" || exit 1\nenum_to "$T" find scripts -type f -print0 || exit 1\n',
    )
    expect(r.rc).toBe(0)
    expect(r.files, `survivors: ${r.files.join(', ')}`).toEqual([])
  })

  // The ordering case. enum_to returns 1 when the producer fails and every caller exits
  // on that, so a registration placed AFTER the producer would leak exactly the file
  // holding the partial list — the one worth not leaving on disk.
  it('leaves nothing behind when the enumeration did not complete', () => {
    const { dir, tmp } = fixture()
    const r = leftBehind(
      dir,
      tmp,
      'T="$(enum_tempfile)" || exit 1\nenum_to "$T" bash -c \'printf "partial\\0"; exit 3\' || exit 1\n',
    )
    expect(r.rc).toBe(1)
    expect(r.files, `survivors: ${r.files.join(', ')}`).toEqual([])
  })
})
