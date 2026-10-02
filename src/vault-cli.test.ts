import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runVaultCli, defaultVaultFilePath, type VaultCliIo } from './index.js'
import { decryptVaultTokens, encryptVaultTokens } from './config/index.js'
import { SafeError, publicErrorMessage } from './errors/index.js'

/**
 * `vault add` / `vault remove` driven IN-PROCESS through injected prompts (#23). The
 * e2e tests spawn the binary, where stdin is never a terminal, so `add` stops at its
 * TTY check there — its success path, the confirm-twice rule and the link handling
 * could otherwise only be exercised by hand. Fake values only: nothing here is a real
 * token shape, and every vault lives in a fresh temp folder.
 */

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

interface VaultRun {
  code: number
  out: string
  asked: string[]
}

async function runVault(
  args: string[],
  answers: string[],
  env: { vaultPath?: string; vaultKey?: string; tokensPath?: string; configPath?: string },
  onAsk?: (question: string) => void,
): Promise<VaultRun> {
  const out: string[] = []
  const asked: string[] = []
  const queue = [...answers]
  const io: VaultCliIo = {
    isTTY: () => true,
    prompt: async (question) => {
      asked.push(question)
      onAsk?.(question)
      const answer = queue.shift()
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`)
      return answer
    },
  }
  const capture = ((chunk: string | Uint8Array): boolean => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  const spies = [
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitCalled(Number(code ?? 0))
    }) as typeof process.exit),
    vi.spyOn(process.stdout, 'write').mockImplementation(capture),
    vi.spyOn(process.stderr, 'write').mockImplementation(capture),
  ]
  const saved = {
    file: process.env.MANYPORTALS_VAULT_FILE,
    key: process.env.MANYPORTALS_VAULT_KEY,
    tokens: process.env.MANYPORTALS_TOKENS_FILE,
    config: process.env.MANYPORTALS_CONFIG,
  }
  // Optional, so a case can express "the environment names no vault" and let the
  // CONFIG answer instead. Every other case still pins it (#145).
  if (env.vaultPath === undefined) delete process.env.MANYPORTALS_VAULT_FILE
  else process.env.MANYPORTALS_VAULT_FILE = env.vaultPath
  if (env.vaultKey === undefined) delete process.env.MANYPORTALS_VAULT_KEY
  else process.env.MANYPORTALS_VAULT_KEY = env.vaultKey
  // Both of these are PINNED on every run, to paths inside the test's temp folder.
  // Unpinned, the CLI falls back to the defaults and reads the DEVELOPER's real
  // ~/.manyportals config and tokens.json in-process: a unit test must not open a
  // credential file, and a test that passes only because the developer's machine
  // happens to be in one state is not a test.
  process.env.MANYPORTALS_TOKENS_FILE = env.tokensPath ?? join(dir, 'no-such-tokens.json')
  process.env.MANYPORTALS_CONFIG = env.configPath ?? join(dir, 'no-such-config.json')
  try {
    const [action, ...rest] = args
    await runVaultCli(action, rest, io)
    throw new Error('runVaultCli returned without exiting')
  } catch (e) {
    if (e instanceof ExitCalled) return { code: e.code, out: out.join(''), asked }
    // A branded error is what the real dispatch prints after "vault failed:". Anything
    // else is a test bug and must fail loudly rather than read as a refusal.
    if (!(e instanceof SafeError)) throw e
    return { code: 1, out: out.join('') + publicErrorMessage(e), asked }
  } finally {
    for (const spy of spies) spy.mockRestore()
    for (const [k, v] of [
      ['MANYPORTALS_VAULT_FILE', saved.file],
      ['MANYPORTALS_VAULT_KEY', saved.key],
      ['MANYPORTALS_TOKENS_FILE', saved.tokens],
      ['MANYPORTALS_CONFIG', saved.config],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const PASS = 'correct horse'
const ASK_PASS = 'vault passphrase (input hidden): '
const ASK_CONFIRM = 'confirm passphrase: '
const askToken = (key: string): string => `token for ${key} (input hidden): `

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mp-vault-cli-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeVault(path: string, tokens: Record<string, string>): Buffer {
  writeFileSync(path, encryptVaultTokens(tokens, PASS), { mode: 0o600 })
  return readFileSync(path)
}

const tokensIn = (path: string): Record<string, string> => ({
  ...decryptVaultTokens(readFileSync(path, 'utf8'), PASS),
})

const tempFilesIn = (folder: string): string[] =>
  readdirSync(folder).filter((name) => name.endsWith('.tmp'))

describe('vault add creates and changes a vault through its prompts (#23)', () => {
  it('creates a new vault: passphrase twice, then the token; nothing secret is printed', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    const run = await runVault(['add', 'PORTAL_A'], [PASS, PASS, ' fake-token-alpha\n'], {
      vaultPath,
    })
    expect(run.code).toBe(0)
    expect(run.asked).toEqual([ASK_PASS, ASK_CONFIRM, askToken('PORTAL_A')])
    expect(tokensIn(vaultPath)).toEqual({ PORTAL_A: 'fake-token-alpha' })
    expect(run.out).toContain('added PORTAL_A to a new vault')
    expect(run.out).not.toContain('fake-token-alpha')
    expect(run.out).not.toContain(PASS)
    expect(tempFilesIn(dir)).toEqual([])
  })

  it('a mismatched confirmation writes nothing and never asks for the token', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    const run = await runVault(['add', 'PORTAL_A'], [PASS, 'correct horse!'], { vaultPath })
    expect(run.code).toBe(1)
    expect(run.asked).toEqual([ASK_PASS, ASK_CONFIRM])
    expect(existsSync(vaultPath)).toBe(false)
  })

  it('an empty passphrase is refused before the token prompt', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    const run = await runVault(['add', 'PORTAL_A'], ['  ', '  '], { vaultPath })
    expect(run.code).toBe(1)
    expect(run.asked).toEqual([ASK_PASS])
    expect(run.out).toContain('must not be empty')
    expect(existsSync(vaultPath)).toBe(false)
  })

  it('an existing vault: one passphrase prompt, proven before the token; add then replace', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'fake-token-alpha' })

    const added = await runVault(['add', 'PORTAL_B'], [PASS, 'fake-token-beta'], { vaultPath })
    expect(added.code).toBe(0)
    expect(added.asked).toEqual([ASK_PASS, askToken('PORTAL_B')])
    expect(added.out).toContain('added PORTAL_B')

    const replaced = await runVault(['add', 'PORTAL_B'], [PASS, 'fake-token-gamma'], {
      vaultPath,
    })
    expect(replaced.code).toBe(0)
    expect(replaced.out).toContain('replaced PORTAL_B')
    expect(tokensIn(vaultPath)).toEqual({
      PORTAL_A: 'fake-token-alpha',
      PORTAL_B: 'fake-token-gamma',
    })
  })

  it('a wrong passphrase stops before the token prompt and leaves the vault byte-identical', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    const before = writeVault(vaultPath, { PORTAL_A: 'fake-token-alpha' })
    const run = await runVault(['add', 'PORTAL_B'], ['not the passphrase'], { vaultPath })
    expect(run.code).toBe(1)
    expect(run.asked).toEqual([ASK_PASS])
    expect(run.out).toMatch(/decryption failed/)
    expect(readFileSync(vaultPath).equals(before)).toBe(true)
  })

  it('a portal key with leading or trailing spaces is refused before any prompt', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    const before = writeVault(vaultPath, { PORTAL_A: 'fake-token-alpha' })
    for (const action of ['add', 'remove']) {
      const run = await runVault([action, 'PORTAL_A '], [], { vaultPath, vaultKey: PASS })
      expect(run.code).toBe(1)
      expect(run.asked).toEqual([])
      expect(run.out).toContain('leading or trailing spaces')
      expect(readFileSync(vaultPath).equals(before)).toBe(true)
    }
  })

  it('refuses when the vault changes between reading it and writing it', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'fake-token-alpha' })
    let concurrent: Buffer | undefined
    // Another run finishes while this one waits at the token prompt.
    const run = await runVault(
      ['add', 'PORTAL_B'],
      [PASS, 'fake-token-beta'],
      { vaultPath },
      (q) => {
        if (q === askToken('PORTAL_B')) {
          concurrent = writeVault(vaultPath, {
            PORTAL_A: 'fake-token-alpha',
            PORTAL_Z: 'fake-token-zeta',
          })
        }
      },
    )
    expect(run.code).toBe(1)
    expect(run.out).toContain('changed while this command was running')
    expect(concurrent).toBeDefined()
    expect(readFileSync(vaultPath).equals(concurrent as Buffer)).toBe(true)
    expect(tempFilesIn(dir)).toEqual([])
  })

  it('an unreadable vault path fails loud for status and add, and is never replaced', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    mkdirSync(vaultPath) // a directory where the vault file should be
    const status = await runVault(['status'], [], { vaultPath, vaultKey: PASS })
    expect(status.code).toBe(1)
    expect(status.out).toContain('could not be read')
    const add = await runVault(['add', 'PORTAL_A'], [PASS, PASS, 'fake-token-alpha'], {
      vaultPath,
      vaultKey: PASS,
    })
    expect(add.code).toBe(1)
    expect(add.out).toContain('could not be read')
    expect(lstatSync(vaultPath).isDirectory()).toBe(true)
  })
})

// Creating links needs privileges on Windows; the rules are the same on every OS.
describe.skipIf(process.platform === 'win32')(
  'vault add / remove and linked vault paths (#23)',
  () => {
    it('a symlinked vault path is followed: the real vault changes and the link stays', async () => {
      const real = join(dir, 'real.vault')
      const link = join(dir, 'link.vault')
      writeVault(real, { PORTAL_A: 'fake-token-alpha', PORTAL_B: 'fake-token-beta' })
      symlinkSync(real, link)
      const run = await runVault(['remove', 'PORTAL_B'], [], { vaultPath: link, vaultKey: PASS })
      expect(run.code).toBe(0)
      // The regression: the rename replaced the LINK, reported "removed", and left the
      // token in the vault the link pointed to.
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(tokensIn(real)).toEqual({ PORTAL_A: 'fake-token-alpha' })
      expect(tempFilesIn(dir)).toEqual([])
    })

    it('a vault with a second hard link is refused, and both names are left unchanged', async () => {
      const real = join(dir, 'real.vault')
      const other = join(dir, 'other.vault')
      const before = writeVault(real, { PORTAL_A: 'fake-token-alpha', PORTAL_B: 'fake-token-beta' })
      linkSync(real, other)
      const run = await runVault(['remove', 'PORTAL_B'], [], { vaultPath: real, vaultKey: PASS })
      expect(run.code).toBe(1)
      expect(run.out).toContain('hard links')
      expect(readFileSync(real).equals(before)).toBe(true)
      expect(readFileSync(other).equals(before)).toBe(true)
    })

    it('a symlink to a missing vault is refused rather than replaced with a new file', async () => {
      const missing = join(dir, 'missing.vault')
      const link = join(dir, 'link.vault')
      symlinkSync(missing, link)
      const run = await runVault(['add', 'PORTAL_A'], ['fake-token-alpha'], {
        vaultPath: link,
        vaultKey: PASS,
      })
      expect(run.code).toBe(1)
      expect(run.out).toContain('does not exist')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(existsSync(missing)).toBe(false)
    })
  },
)

/**
 * A credential in the KEY position (#74, #75). A token file written the wrong way
 * round gives `{"<token>": "PORTAL_A"}`, and a PAT satisfies the portal-key grammar,
 * so nothing rejected it: `vault encrypt` printed the token to stdout and then told
 * the operator to run `vault status`, which printed it again. Assembled from parts so
 * this file is not itself a credential-shaped surface.
 */
const INVERTED_TOKEN = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')

describe('a credential in the key position', () => {
  it('vault encrypt refuses an inverted token file and prints no part of the token', async () => {
    const tokensPath = join(dir, 'tokens.json')
    writeFileSync(tokensPath, JSON.stringify({ [INVERTED_TOKEN]: 'PORTAL_A' }))
    const r = await runVault(['encrypt'], [PASS, PASS], {
      vaultPath: join(dir, 'tokens.vault'),
      tokensPath,
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('inverted')
    expect(r.out).not.toContain(INVERTED_TOKEN)
    // Not even a fragment: the uuid halves are what makes it recognisable.
    expect(r.out).not.toContain('0f2e4c6a')
    expect(r.out).not.toContain('c1d2e3f4a5b6')
    expect(existsSync(join(dir, 'tokens.vault'))).toBe(false)
  })

  it('vault status refuses an inverted vault and prints no part of the token', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { [INVERTED_TOKEN]: 'PORTAL_A' })
    const r = await runVault(['status'], [], { vaultPath, vaultKey: PASS })
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain(INVERTED_TOKEN)
    expect(r.out).not.toContain('0f2e4c6a')
  })

  it('a normal vault still lists its portal keys', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'plain-a', PORTAL_B: 'plain-b' })
    const r = await runVault(['status'], [], { vaultPath, vaultKey: PASS })
    expect(r.code).toBe(0)
    expect(r.out).toContain('PORTAL_A')
    expect(r.out).toContain('PORTAL_B')
    expect(r.out).not.toContain('plain-a')
  })
})

/**
 * A vault change that does not have the effect the operator wanted (#76). `remove`
 * reported "removed PORTAL_B" and exited 0 while the plaintext token file or an
 * environment variable still served that portal, and the documented onboarding
 * sequence leaves the plaintext file in place on purpose. Environment variables
 * outrank the vault, so `add` has the mirror defect: it reports a rotation the server
 * will ignore.
 */
describe('a vault change that did not take effect', () => {
  function writeConfig(tokenEnv: string): string {
    const path = join(dir, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({
        portals: {
          PORTAL_A: { tokenEnv, expectedHubId: 0, label: 'Example Co A', allowWrite: false },
        },
        writeMode: 'propose',
      }),
    )
    return path
  }

  /**
   * The regression this pins: `vault add` resolved the vault on its own, so it wrote to
   * the default while the SERVER read the config's `vaultFile`. A token added to a vault
   * nothing reads, reported as success (#145).
   */
  // Assembled from parts, never written contiguously: credscan refuses a
  // credential-SHAPED literal in a shipped surface, and src/ ships wholesale.
  const SYNTHETIC_PAT = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')

  it('writes to the vault the config names, not to the default', async () => {
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        portals: {
          PORTAL_A: { tokenEnv: 'T_A', expectedHubId: 0, label: 'Example Co A', allowWrite: false },
        },
        writeMode: 'propose',
        // Relative, so it means "beside this config" wherever the config is.
        vaultFile: 'declared.vault',
      }),
    )
    const declared = join(dir, 'declared.vault')
    const r = await runVault(['add', 'PORTAL_A'], [SYNTHETIC_PAT, 'hunter2'], {
      vaultKey: 'hunter2',
      configPath,
    })
    expect(r.code, r.out).toBe(0)
    expect(existsSync(declared), `expected a vault at ${declared}; got: ${r.out}`).toBe(true)
    // The half that catches a regression to the default, WITHOUT looking at the default.
    // The obvious negative — assert nothing exists at defaultVaultFilePath() — inspects
    // the developer's own ~/.manyportals/tokens.vault, which this file's harness comment
    // forbids for good reason: a unit test must not open a credential file, and one that
    // passes because a machine happens to be in one state is not a test. So the CLI is
    // asked which path it used instead, which is the thing actually under test.
    expect(r.out).toContain(declared)
    expect(r.out).not.toContain(defaultVaultFilePath())
  })

  it('remove says the token is revoked when nothing else serves the portal', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'plain-a', PORTAL_B: 'plain-b' })
    const r = await runVault(['remove', 'PORTAL_B'], [PASS], { vaultPath, vaultKey: PASS })
    expect(r.code).toBe(0)
    expect(r.out).toContain('removed PORTAL_B from the vault')
    expect(r.out).toContain('the token is revoked')
  })

  it('remove refuses to call it a revocation while the plaintext file still has the key', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    const tokensPath = join(dir, 'tokens.json')
    writeVault(vaultPath, { PORTAL_A: 'plain-a', PORTAL_B: 'plain-b' })
    writeFileSync(tokensPath, JSON.stringify({ PORTAL_B: 'still-here' }))
    const r = await runVault(['remove', 'PORTAL_B'], [PASS], {
      vaultPath,
      vaultKey: PASS,
      tokensPath,
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('THE TOKEN IS NOT REVOKED')
    expect(r.out).toContain(tokensPath)
    // The vault change itself still happened and is still reported.
    expect(r.out).toContain('removed PORTAL_B from the vault')
    expect(r.out).not.toContain('still-here')
  })

  it('add refuses to call it a rotation while an env var outranks the vault', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'old-a' })
    const configPath = writeConfig('HUBSPOT_TOKEN_PORTAL_A_TEST')
    const saved = process.env.HUBSPOT_TOKEN_PORTAL_A_TEST
    process.env.HUBSPOT_TOKEN_PORTAL_A_TEST = 'env-wins'
    try {
      const r = await runVault(['add', 'PORTAL_A'], [PASS, 'new-a'], {
        vaultPath,
        vaultKey: PASS,
        configPath,
      })
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('THE NEW TOKEN WILL NOT BE USED')
      expect(r.out).toContain('HUBSPOT_TOKEN_PORTAL_A_TEST')
      expect(r.out).toContain('replaced PORTAL_A')
      expect(r.out).not.toContain('new-a')
      expect(r.out).not.toContain('env-wins')
    } finally {
      if (saved === undefined) delete process.env.HUBSPOT_TOKEN_PORTAL_A_TEST
      else process.env.HUBSPOT_TOKEN_PORTAL_A_TEST = saved
    }
  })

  it('add does NOT warn merely because the plaintext file has the key', async () => {
    // Resolution is env, then vault, then file, so the plaintext file cannot shadow a
    // vault entry. `vault encrypt` leaves tokens.json in place on purpose, so warning
    // here would fire on the documented happy path and train people to ignore it.
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'old-a' })
    const tokensPath = join(dir, 'tokens.json')
    writeFileSync(tokensPath, JSON.stringify({ PORTAL_A: 'older-plaintext' }))
    const r = await runVault(['add', 'PORTAL_A'], [PASS, 'new-a'], {
      vaultPath,
      vaultKey: PASS,
      tokensPath,
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain('replaced PORTAL_A')
    expect(r.out).not.toContain('WILL NOT BE USED')
    expect(r.out).not.toContain('older-plaintext')
  })

  it('remove DOES warn when the plaintext file has the key', async () => {
    // The mirror case: with the vault entry gone, resolution falls through to the file.
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'a', PORTAL_B: 'b' })
    const tokensPath = join(dir, 'tokens.json')
    writeFileSync(tokensPath, JSON.stringify({ PORTAL_B: 'still-here' }))
    const r = await runVault(['remove', 'PORTAL_B'], [PASS], {
      vaultPath,
      vaultKey: PASS,
      tokensPath,
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('NOT REVOKED')
  })

  it('reports UNKNOWN rather than clean when a config exists but cannot be read', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'plain-a', PORTAL_B: 'plain-b' })
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, 'this is not json')
    const r = await runVault(['remove', 'PORTAL_B'], [PASS], {
      vaultPath,
      vaultKey: PASS,
      configPath,
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('UNKNOWN')
  })

  it('an absent config is not treated as unknown', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    writeVault(vaultPath, { PORTAL_A: 'plain-a', PORTAL_B: 'plain-b' })
    const r = await runVault(['remove', 'PORTAL_B'], [PASS], {
      vaultPath,
      vaultKey: PASS,
      configPath: join(dir, 'definitely-absent.json'),
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain('the token is revoked')
  })
})

/**
 * `vault encrypt` was the one vault write that skipped every protection add and
 * remove have: no mode reset (writeFileSync's `mode` applies only on create, so
 * re-encrypting over a 0666 vault left it 0666), no atomic replace, and no existence
 * check at all. Since it is also the only way to change the passphrase (#55),
 * operators run it over an existing vault (#78).
 */
describe('vault encrypt', () => {
  function tokensFile(map: Record<string, string>): string {
    const path = join(dir, 'tokens.json')
    writeFileSync(path, JSON.stringify(map))
    return path
  }

  it('creates the vault, owner-only on POSIX', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    const r = await runVault(['encrypt'], [], {
      vaultPath,
      vaultKey: PASS,
      tokensPath: tokensFile({ PORTAL_A: 'plain-a' }),
    })
    expect(r.code).toBe(0)
    // NTFS has no POSIX permission bits, so this assertion is POSIX-only. The rest of
    // the case (the vault exists and decrypts) runs everywhere.
    if (process.platform !== 'win32') expect(lstatSync(vaultPath).mode & 0o077).toBe(0)
    expect(Object.keys(decryptVaultTokens(readFileSync(vaultPath, 'utf8'), PASS))).toEqual([
      'PORTAL_A',
    ])
  })

  it('refuses to replace an existing vault, and leaves it byte-identical', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    // The vault holds a portal added later with `vault add`; the plaintext file does
    // not. Replacing would lose PORTAL_B and reinstate the older PORTAL_A token.
    const before = writeVault(vaultPath, { PORTAL_A: 'current-a', PORTAL_B: 'only-in-vault' })
    const r = await runVault(['encrypt'], [], {
      vaultPath,
      vaultKey: PASS,
      tokensPath: tokensFile({ PORTAL_A: 'older-rotated-away' }),
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('refusing to replace')
    expect(r.out).toContain('vault add')
    expect(readFileSync(vaultPath)).toEqual(before)
    const still = decryptVaultTokens(readFileSync(vaultPath, 'utf8'), PASS)
    expect(Object.keys(still).sort()).toEqual(['PORTAL_A', 'PORTAL_B'])
    expect(still.PORTAL_A).toBe('current-a')
  })

  it('does not print the token it encrypted', async () => {
    const vaultPath = join(dir, 'tokens.vault')
    const r = await runVault(['encrypt'], [], {
      vaultPath,
      vaultKey: PASS,
      tokensPath: tokensFile({ PORTAL_A: 'plain-a-secret' }),
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain('PORTAL_A')
    expect(r.out).not.toContain('plain-a-secret')
  })
})
