import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The stale-worktree report (#216).
 *
 * The rule that an agent worktree closes in the same sitting existed and nothing read it,
 * so five were found at once, two holding six-day-old uncommitted changes. The check is a
 * warning rather than a gate, for the reason on the ticket: failing verify on a stale
 * worktree blocks every commit until cleanup, and the thing protected is tidiness.
 *
 * THE AGE THRESHOLD IS THE DESIGN, so it is tested in BOTH directions. A worktree minutes
 * old must not be reported, because a check that fires during normal delegation is a check
 * that gets switched off. The age comparison carries the registered mutation.
 *
 * Every fixture here sits under a directory whose name contains a SPACE, which is the trap
 * the ticket records: `git worktree list --porcelain | awk '{print $2}'` returns an empty
 * list on this repository's own path, and an empty list is indistinguishable from a clean
 * repository (#108, #109).
 */
const REPO = process.cwd()

// worktree-check.sh is dev-only and is NOT in the assembly allowlist, so it is absent from
// the public tree where this file still ships. Driving it there fails, which is #132's
// class. Same guard src/publish-sync.test.ts and src/release-gate.test.ts use, for the
// same reason: the layout declaration, read rather than guessed.
const LAYOUT = readFileSync(join(REPO, '.manyportals-layout'), 'utf8').trim()

const DAY = 86_400_000

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/**
 * A real repository with a real worktrees directory, under a path containing a space.
 *
 * Real worktrees rather than bare directories: the dirty and ahead-of-main answers come
 * from git, and a fixture that could not be asked those questions would exercise only the
 * cannot-verify branch.
 */
function workspace(): { repo: string; worktrees: string } {
  // The space is deliberate and load-bearing. See the trap above.
  const base = join(mkdtempSync(join(tmpdir(), 'mp-wt-')), 'with space')
  const repo = join(base, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 't@example.com'])
  git(repo, ['config', 'user.name', 'T'])
  // Signing OFF for fixtures (#182): global config signs every commit through an agent,
  // so without this a fixture commit fails whenever the vault is locked, which is a
  // developer-machine-only flake that CI never sees.
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'base'])
  const worktrees = join(repo, '.claude', 'worktrees')
  mkdirSync(worktrees, { recursive: true })
  return { repo, worktrees }
}

/** Add a worktree, optionally dirty, optionally ahead of main, optionally backdated. */
function addWorktree(
  ws: { repo: string; worktrees: string },
  name: string,
  opts: { branch: string; ageDays?: number; dirty?: boolean; commits?: number } = {
    branch: 'wt',
  },
): string {
  const path = join(ws.worktrees, name)
  git(ws.repo, ['worktree', 'add', '-q', '-b', opts.branch, path])
  for (let i = 0; i < (opts.commits ?? 0); i++) {
    git(path, ['commit', '-q', '--allow-empty', '-m', `extra ${i}`])
  }
  if (opts.dirty === true) writeFileSync(join(path, 'scratch.txt'), 'work in progress\n')
  if (opts.ageDays !== undefined) {
    // The gitfile git wrote at creation IS the age signal, so backdating it is backdating
    // the worktree. Done last, so nothing above touches it again.
    const when = new Date(Date.now() - opts.ageDays * DAY)
    utimesSync(join(path, '.git'), when, when)
  }
  return path
}

function check(args: string[]): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/worktree-check.sh', ...args], {
      cwd: REPO,
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

describe.skipIf(LAYOUT !== 'dev')('worktree-check.sh', () => {
  it('reports a worktree that has been there for days', () => {
    // THE REGISTERED CASE. The mutation inverts the age comparison, after which a stale
    // worktree is skipped and this reports clean.
    const ws = workspace()
    addWorktree(ws, 'agent-abandoned', { branch: 'abandoned', ageDays: 6 })
    const r = check([ws.worktrees])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('agent-abandoned')
    expect(r.out).toContain('6d')
  })

  it('does not report a worktree created minutes ago', () => {
    // THE OTHER DIRECTION, and the whole reason there is a threshold. An in-flight agent's
    // worktree is minutes old. A check that fired on this one would be noise during normal
    // delegation and would be switched off inside a week.
    const ws = workspace()
    addWorktree(ws, 'agent-in-flight', { branch: 'inflight' })
    const r = check([ws.worktrees])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('clean')
    expect(r.out).not.toContain('agent-in-flight')
  })

  it('says when a stale worktree is dirty', () => {
    const ws = workspace()
    addWorktree(ws, 'agent-dirty', { branch: 'dirty', ageDays: 3, dirty: true })
    const r = check([ws.worktrees])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('DIRTY')
  })

  it('says when a stale worktree holds commits not on main', () => {
    const ws = workspace()
    addWorktree(ws, 'agent-ahead', { branch: 'ahead', ageDays: 3, commits: 2 })
    const r = check([ws.worktrees])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('2 commit(s) not on main')
  })

  it('reports a stale worktree whose own name contains a space', () => {
    // THE TRAP, named. Splitting `git worktree list --porcelain` on whitespace loses this
    // worktree, and losing it looks exactly like having none.
    const ws = workspace()
    addWorktree(ws, 'agent with space', { branch: 'spacer', ageDays: 4 })
    const r = check([ws.worktrees])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('agent with space')
  })

  it('refuses rather than reporting clean when a directory is not a worktree', () => {
    // A leftover directory git cannot speak for is exactly the state this check exists to
    // surface, so "I could not look" must not come back as "nothing to report".
    const ws = workspace()
    mkdirSync(join(ws.worktrees, 'agent-leftover'), { recursive: true })
    const r = check([ws.worktrees])
    expect(r.rc).toBe(2)
    expect(r.out).toContain('cannot verify')
  })

  it('says so when there is no worktrees directory at all', () => {
    const ws = workspace()
    const r = check([join(ws.repo, 'nothing-here')])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('no directory at')
  })

  it('warns about the real worktrees directory without failing the suite', () => {
    // THE WARNING, which is the point of the check: it runs inside `npm run verify`, on
    // every commit, and names what to clean up without blocking the commit. The exit
    // status is deliberately NOT asserted; a stale worktree is a message, not a defect.
    // What IS asserted is that the check spoke, so a broken one is not silent.
    const r = check([])
    expect(r.out).toContain('worktree-check:')
    if (r.rc !== 0) console.log(r.out.trimEnd())
  })
})
