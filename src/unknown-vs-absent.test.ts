import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTokenSources, dataFilePermWarnings, trailFileNotes } from './index.js'

/**
 * `existsSync` answers false for "there is nothing there" AND for "I could not look",
 * and a bare `catch` around a stat does the same. Every site below reported the safe
 * answer for the second case, so a diagnostic said healthy, or absent, about something
 * it had not been able to examine (#111).
 *
 * The correct shape was already in this file at `fileModeWarning`, with the comment
 * "this catch used to treat every error as absence". The 2026-09-27 sweep fixed two
 * neighbours and stopped one line short of the third.
 *
 * Every fixture is a fresh temp directory whose mode is restored in afterEach, so a
 * failure cannot leave an unreadable directory behind.
 */
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const skip = process.platform === 'win32' || asRoot

/** A directory that cannot be traversed, restored after the test whatever happens. */
function unreadableDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'unknown-'))
  cleanups.push(() => {
    try {
      chmodSync(d, 0o755)
    } catch {
      // Already restored, or already gone. Nothing to do.
    }
    rmSync(d, { recursive: true, force: true })
  })
  return d
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe.skipIf(skip)('a permission check that cannot look says so (#111)', () => {
  it('does not report a vault as unexamined-and-fine when its directory cannot be traversed', () => {
    // The headline case: a mode-0666 vault produced ZERO warnings and doctor printed
    // "status: healthy", because existsSync came back false for an un-traversable
    // parent and the function returned [] before reaching any check.
    const dir = unreadableDir()
    const vault = join(dir, 'tokens.vault')
    writeFileSync(vault, '{}\n')
    chmodSync(vault, 0o666)
    chmodSync(dir, 0o000)
    // The plaintext token file lives ELSEWHERE, and readable. It already fails loudly
    // on an unreadable path, so leaving it inside the locked directory would prove
    // that function's behaviour rather than the vault probe's.
    const readable = mkdtempSync(join(tmpdir(), 'unknown-ok-'))
    cleanups.push(() => rmSync(readable, { recursive: true, force: true }))

    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: vault,
        MANYPORTALS_TOKENS_FILE: join(readable, 'tokens.json'),
        MANYPORTALS_CONFIG: undefined,
      },
      () => {
        const ts = buildTokenSources()
        const said = [...ts.securityWarnings, ...ts.notes].join('\n')
        expect(said).toMatch(/cannot (check|tell)/i)
        expect(ts.vaultFilePresence).toBe('unknown')
      },
    )
  })

  it('distinguishes a vault that is genuinely absent from one it cannot see', () => {
    // Without this, the case above could be satisfied by warning on everything.
    const dir = mkdtempSync(join(tmpdir(), 'unknown-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: join(dir, 'tokens.vault'),
        MANYPORTALS_TOKENS_FILE: join(dir, 'tokens.json'),
        MANYPORTALS_CONFIG: undefined,
      },
      () => {
        const ts = buildTokenSources()
        expect(ts.vaultFilePresence).toBe('absent')
        expect([...ts.securityWarnings, ...ts.notes].join('\n')).not.toMatch(/cannot tell/i)
      },
    )
  })
})

describe.skipIf(skip)('a data-folder scan that cannot list says so (#111)', () => {
  it('reports that the files inside an unlistable folder were not checked', () => {
    // `catch { continue }` meant a mode-0644 trail file inside a mode-000 audit.d was
    // never examined, and the absence of a warning read as "nothing to protect yet".
    const data = mkdtempSync(join(tmpdir(), 'unknown-data-'))
    const folder = join(data, 'audit.d')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'w-abc.jsonl'), '{}\n')
    chmodSync(folder, 0o000)
    cleanups.push(() => {
      try {
        chmodSync(folder, 0o755)
      } catch {
        // Already restored.
      }
      rmSync(data, { recursive: true, force: true })
    })

    const warnings = dataFilePermWarnings(data).join('\n')
    expect(warnings).toMatch(/cannot list/i)
    expect(warnings).toMatch(/NOT checked/)
  })

  it('says the count is unknown rather than printing no note at all', () => {
    const data = mkdtempSync(join(tmpdir(), 'unknown-data-'))
    const folder = join(data, 'audit.d')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'w-abc.jsonl'), '{}\n')
    chmodSync(folder, 0o000)
    cleanups.push(() => {
      try {
        chmodSync(folder, 0o755)
      } catch {
        // Already restored.
      }
      rmSync(data, { recursive: true, force: true })
    })

    expect(trailFileNotes(data).join('\n')).toMatch(/unknown/i)
  })

  it('stays quiet about a data directory that simply has no folders yet', () => {
    const data = mkdtempSync(join(tmpdir(), 'unknown-data-'))
    cleanups.push(() => rmSync(data, { recursive: true, force: true }))
    expect(dataFilePermWarnings(data).join('\n')).not.toMatch(/cannot list/i)
    expect(trailFileNotes(data)).toEqual([])
  })
})
