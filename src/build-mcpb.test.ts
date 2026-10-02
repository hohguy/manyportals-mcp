import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

/**
 * The bundle's surface gate, driven directly (#120).
 *
 * `build-mcpb.sh` used to decide what may ship with a blocklist of seven names tested
 * at the stage root. Both of its defects were reproduced against real bundles before
 * this file was written, which is the part that matters: in a normal build nothing
 * stages any of those seven, so the loop had never had anything to catch and no amount
 * of running it would have surfaced the shape problem.
 *
 *   - a staged `scripts/` printed "bundle audit clean", exited 0, and produced a .mcpb
 *     holding all 22 files of scripts/ including publish-sync.sh
 *   - `dist/internal/notes.md` was missed by a list that NAMES the private tree, and
 *     shipped, because `[ -e "$STAGE/the private tree" ]` only looks at the stage root
 *
 * The replacement is an allowlist over the PACKED ARCHIVE, and it is reached here
 * through `--audit-archive`, which reads a listing on stdin and does nothing else. That
 * entry point exists so these cases cost milliseconds: a test that has to build a
 * bundle is slow, flaky and ends up skipped, and a gate nobody can make fire is the
 * defect class this repository keeps finding.
 *
 * POSIX only. The script is bash; the Windows leg is #96.
 */
const REPO = process.cwd()

function audit(listing: string): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/build-mcpb.sh', '--audit-archive'], {
      cwd: REPO,
      encoding: 'utf8',
      input: listing,
      stdio: ['pipe', 'pipe', 'pipe'],
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

/**
 * MEASURED, not invented. These are the 27 non-node_modules entries of a real
 * `build/manyportals-mcp.mcpb` as `unzip -Z1` lists them, at version 0.1.4 on
 * 2026-09-30, with two dependency paths standing in for the other 1559.
 *
 * It is written out rather than read from `dist/`, because `npm run verify` runs the
 * tests BEFORE the build and a listing derived from whatever happens to be on disk
 * would make this case pass by agreeing with itself.
 */
const REAL_LISTING = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'manifest.json',
  'package.json',
  'dist/index.js',
  'dist/audit/index.js',
  'dist/boot/index.js',
  'dist/config/credential-shape.js',
  'dist/config/index.js',
  'dist/config/schema.js',
  'dist/config/vault.js',
  'dist/doctor/index.js',
  'dist/errors/index.js',
  'dist/hubspot/http.js',
  'dist/hubspot/index.js',
  'dist/hubspot/types.js',
  'dist/mcp/handlers.js',
  'dist/mcp/server.js',
  'dist/plans/index.js',
  'dist/plans/named-operations.js',
  'dist/portals/index.js',
  'dist/preflight/index.js',
  'dist/reads/index.js',
  'dist/safety/index.js',
  'dist/store/jsonl-dir.js',
  'dist/util/index.js',
  'node_modules/zod/package.json',
  'node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js',
]

const withEntry = (extra: string): string => [...REAL_LISTING, extra].join('\n') + '\n'

describe.skipIf(process.platform === 'win32')('build-mcpb.sh archive allowlist', () => {
  // The case an over-strict allowlist breaks, and an over-strict gate is a different
  // failure wearing the same green: the build would stop refusing to ship a leak and
  // start refusing to ship anything, which someone would then relax rather than read.
  it('accepts the listing a real bundle produces', () => {
    const r = audit(REAL_LISTING.join('\n') + '\n')
    expect(r.out).toContain('archive audit clean')
    expect(r.rc).toBe(0)
  })

  // The first defect, verbatim: a fixed list of seven names that does not contain
  // `scripts`. publish-sync.sh is on its own DENY_PATHS and is one of
  // prepublish-guard.sh's private-tree sentinels, so this is the assembler shipping
  // inside the extension.
  it('refuses a scripts directory that reached the archive', () => {
    const r = audit(withEntry('scripts/publish-sync.sh'))
    expect(r.out).toContain('scripts/publish-sync.sh')
    expect(r.rc).toBe(1)
  })

  // Same defect, a different name the list does not hold. Coverage output is generated
  // from the source tree and can name every file in it.
  it('refuses a coverage file that reached the archive', () => {
    const r = audit(withEntry('coverage/lcov.info'))
    expect(r.out).toContain('coverage/lcov.info')
    expect(r.rc).toBe(1)
  })

  // The SECOND defect, and the one the allowlist has to work to catch: this entry is
  // inside `dist/`, which is allowlisted, so only the file type separates a private
  // tree from the compiled output. A rule of `dist/*` would pass it.
  //
  // The title carries no regex metacharacter on purpose: it is named in the guard
  // register's `expect`, which vitest applies as a `-t` REGEX.
  it('refuses a private tree nested inside dist', () => {
    const r = audit(withEntry('dist/internal/notes.md'))
    expect(r.out).toContain('dist/internal/notes.md')
    expect(r.rc).toBe(1)
  })

  // A zip entry is a name, not a resolved path, so `dist/../private.js` matches
  // `dist/*.js` while denoting somewhere else. Same shape as the out-guard dot-leaf
  // case (#106): compared as one thing, denoting another.
  it('refuses an entry that climbs out of an allowed directory', () => {
    const r = audit(withEntry('dist/../private.js'))
    expect(r.out).toContain('dist/../private.js')
    expect(r.rc).toBe(1)
  })

  // A check must not be satisfiable by removing its own input (#113). An empty listing
  // is "I could not look", which is rc 2 and fails the build closed, not a clean bundle.
  it('fails closed on an empty listing', () => {
    const r = audit('')
    expect(r.out).toContain('EMPTY')
    expect(r.rc).toBe(2)
  })

  // A plain `while read` drops a final line with no newline after it, so the last entry
  // in an archive would go unexamined. It is the last one that a `>>` append writes.
  it('reads the last entry when the listing has no trailing newline', () => {
    const r = audit('LICENSE\nscripts/publish-sync.sh')
    expect(r.out).toContain('scripts/publish-sync.sh')
    expect(r.rc).toBe(1)
  })

  // The entry point is a listing reader and nothing else. A stray argument must not be
  // taken as a file to audit or silently ignored.
  it('refuses an argument after the audit flag', () => {
    try {
      execFileSync('bash', ['scripts/build-mcpb.sh', '--audit-archive', 'build/x.mcpb'], {
        cwd: REPO,
        encoding: 'utf8',
        input: 'LICENSE\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      expect.unreachable('a stray argument was accepted')
    } catch (e) {
      const x = e as { status?: number; stderr?: string }
      expect(x.stderr ?? '').toContain('takes no argument')
      expect(x.status).toBe(2)
    }
  })
})
