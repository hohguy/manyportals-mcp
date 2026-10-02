import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Nothing is removed unless this tool created it (#104).
 *
 * #62 was `--out /Users` becoming `//Users` through path arithmetic and slipping an
 * ancestor guard that compared strings. That shape is refused now, but a deny-list
 * over string shapes has to enumerate every hazardous shape, and #62 was exactly one
 * nobody enumerated. These cases pin the other question: a directory is removable
 * only while it carries a marker this tool wrote, which holds even when the code
 * computing the path is wrong, because the check never inspects the string.
 *
 * Every fixture here is a fresh temp directory, so a guard that wrongly ALLOWS a
 * removal destroys only its own fixture.
 */
const MARKER = '.manyportals-staging'

function sh(fn: string, args: string[]): { rc: number; out: string } {
  try {
    const out = execFileSync(
      'bash',
      ['-c', `source scripts/staging-guard.sh; ${fn} "$@"`, '_', ...args],
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
const claim = (dir: string) => sh('staging_claim', [dir])
const wipe = (dir: string) => sh('staging_wipe', [dir, 'test dir'])
const wipeFile = (file: string, parent: string) => sh('staging_wipe_file', [file, parent])

const tmp = (): string => mkdtempSync(join(tmpdir(), 'stage-'))

describe('staging_claim', () => {
  it('creates the directory and marks it', () => {
    const d = join(tmp(), 'out')
    expect(claim(d).rc).toBe(0)
    expect(existsSync(d)).toBe(true)
    expect(readFileSync(join(d, MARKER), 'utf8')).toContain('ManyPortals staging directory')
  })
})

describe('staging_wipe', () => {
  it('removes a directory this tool created', () => {
    const d = join(tmp(), 'out')
    claim(d)
    writeFileSync(join(d, 'assembled.txt'), 'x')
    expect(wipe(d).rc).toBe(0)
    expect(existsSync(d)).toBe(false)
  })

  it('REFUSES a directory it did not create, and leaves it untouched', () => {
    // The #104 case. This is what /Users looks like to the guard.
    const d = tmp()
    writeFileSync(join(d, 'someones-work.txt'), 'irreplaceable')
    const r = wipe(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('this tool did not create it')
    expect(existsSync(d)).toBe(true)
    expect(existsSync(join(d, 'someones-work.txt'))).toBe(true)
  })

  it('refuses even when the marker sits one level down, not in the target', () => {
    // A parent of a staging dir is not itself a staging dir.
    const parent = tmp()
    claim(join(parent, 'inner'))
    const r = wipe(parent)
    expect(r.rc).toBe(1)
    expect(existsSync(join(parent, 'inner', MARKER))).toBe(true)
  })

  it('refuses a symlink rather than reasoning about it', () => {
    // rm -rf would remove the link, but the marker test follows it, so a link at a
    // marked directory would authorise removing a different path than was checked.
    const real = join(tmp(), 'real')
    claim(real)
    const link = join(tmp(), 'link')
    symlinkSync(real, link)
    const r = wipe(link)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('symlink')
    expect(existsSync(join(real, MARKER))).toBe(true)
  })

  it('refuses a path that is a file', () => {
    const f = join(tmp(), 'a-file')
    writeFileSync(f, 'x')
    expect(wipe(f).rc).toBe(1)
    expect(existsSync(f)).toBe(true)
  })

  it('refuses an empty path', () => {
    expect(sh('staging_wipe', ['']).rc).toBe(1)
  })

  it('treats a path that does not exist as nothing to do', () => {
    expect(wipe(join(tmp(), 'never-made')).rc).toBe(0)
  })

  it('supports the wipe-then-claim cycle a repeat run performs', () => {
    const d = join(tmp(), 'out')
    claim(d)
    writeFileSync(join(d, 'run1.txt'), 'x')
    expect(wipe(d).rc).toBe(0)
    expect(claim(d).rc).toBe(0)
    expect(existsSync(join(d, 'run1.txt'))).toBe(false)
    expect(existsSync(join(d, MARKER))).toBe(true)
  })
})

describe('staging_wipe_file', () => {
  it('removes a file that sits in its expected parent', () => {
    const parent = tmp()
    const f = join(parent, 'bundle.mcpb')
    writeFileSync(f, 'x')
    expect(wipeFile(f, parent).rc).toBe(0)
    expect(existsSync(f)).toBe(false)
  })

  it('refuses a file outside the expected parent, and leaves it', () => {
    const parent = tmp()
    const elsewhere = tmp()
    const f = join(elsewhere, 'bundle.mcpb')
    writeFileSync(f, 'x')
    const r = wipeFile(f, parent)
    expect(r.rc).toBe(1)
    expect(existsSync(f)).toBe(true)
  })

  it('refuses a directory', () => {
    const parent = tmp()
    const d = join(parent, 'not-a-file')
    mkdirSync(d)
    expect(wipeFile(d, parent).rc).toBe(1)
    expect(existsSync(d)).toBe(true)
  })

  it('treats an absent file as nothing to do', () => {
    const parent = tmp()
    expect(wipeFile(join(parent, 'gone.mcpb'), parent).rc).toBe(0)
  })
})

/**
 * Presence of a marker was never origin. `-f` FOLLOWS a symlink, an empty file of the
 * right name satisfied it, and a copied or hard-linked marker satisfied it too, so an
 * unrelated directory carrying any of them was deleted. Each input below deleted a
 * fixture containing a `precious/` subdirectory when the reviewer ran it (#106).
 *
 * The marker now records the directory it was written FOR, and a copy carries the
 * original path with it.
 */
describe('the marker establishes origin, not presence (#106)', () => {
  /** A directory that is NOT ours, holding something that must survive. */
  function foreign(): string {
    const d = join(tmp(), 'not-ours')
    mkdirSync(join(d, 'precious'), { recursive: true })
    writeFileSync(join(d, 'precious', 'keep.txt'), 'keep me\n')
    return d
  }

  const survived = (d: string) => existsSync(join(d, 'precious', 'keep.txt'))

  it('refuses an empty file of the right name', () => {
    const d = foreign()
    writeFileSync(join(d, MARKER), '')
    expect(wipe(d).rc).toBe(1)
    expect(survived(d)).toBe(true)
  })

  it('refuses a file of the right name carrying unrelated text', () => {
    const d = foreign()
    writeFileSync(join(d, MARKER), 'notes to self\n')
    expect(wipe(d).rc).toBe(1)
    expect(survived(d)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('refuses a marker symlinked to a real one', () => {
    const ours = join(tmp(), 'ours')
    expect(claim(ours).rc).toBe(0)
    const d = foreign()
    symlinkSync(join(ours, MARKER), join(d, MARKER))
    const r = wipe(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('symlink')
    expect(survived(d)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('refuses a marker HARD-linked from a real one', () => {
    // Identical bytes and the same inode, so nothing about the file itself differs.
    // What differs is the path recorded inside it.
    const ours = join(tmp(), 'ours')
    expect(claim(ours).rc).toBe(0)
    const d = foreign()
    linkSync(join(ours, MARKER), join(d, MARKER))
    const r = wipe(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('written for a different directory')
    expect(survived(d)).toBe(true)
  })

  it('refuses a marker copied from a real one', () => {
    const ours = join(tmp(), 'ours')
    expect(claim(ours).rc).toBe(0)
    const d = foreign()
    copyFileSync(join(ours, MARKER), join(d, MARKER))
    expect(wipe(d).rc).toBe(1)
    expect(survived(d)).toBe(true)
  })

  it('refuses a claimed directory that was then renamed', () => {
    // The marker is still ours and still intact; it names somewhere else now.
    const base = tmp()
    const ours = join(base, 'ours')
    expect(claim(ours).rc).toBe(0)
    mkdirSync(join(ours, 'precious'), { recursive: true })
    writeFileSync(join(ours, 'precious', 'keep.txt'), 'keep me\n')
    const moved = join(base, 'moved')
    renameSync(ours, moved)
    expect(wipe(moved).rc).toBe(1)
    expect(survived(moved)).toBe(true)
  })

  it('still removes the directory it actually claimed', () => {
    // The point of the whole guard is that the ordinary path keeps working.
    const ours = join(tmp(), 'ours')
    expect(claim(ours).rc).toBe(0)
    mkdirSync(join(ours, 'sub'), { recursive: true })
    writeFileSync(join(ours, 'sub', 'file.txt'), 'x\n')
    expect(wipe(ours).rc).toBe(0)
    expect(existsSync(ours)).toBe(false)
  })

  it('records the resolved directory on the second line', () => {
    const ours = join(tmp(), 'ours')
    expect(claim(ours).rc).toBe(0)
    const [magic, recorded] = readFileSync(join(ours, MARKER), 'utf8').split('\n')
    expect(magic).toContain('ManyPortals staging directory')
    expect(recorded?.endsWith('/ours')).toBe(true)
  })
})
