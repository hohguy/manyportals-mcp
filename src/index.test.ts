import { describe, it, expect } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  PRODUCT,
  buildTokenSources,
  dataFilePermWarnings,
  startServer,
  defaultConfigPath,
  defaultVaultFilePath,
  packageVersion,
  resolveConfigPath,
  trailFileNotes,
} from './index.js'
import { FakeConfigProvider, encryptVaultTokens, loadConfig } from './config/index.js'
import { SafeError } from './errors/index.js'
import { FakeHubSpotClient } from './hubspot/fake.js'

describe('bootstrap', () => {
  it('toolchain runs and the module resolves under NodeNext', () => {
    expect(PRODUCT).toBe('manyportals-mcp')
  })

  it('defaultConfigPath points at the per-user config dir', () => {
    expect(defaultConfigPath()).toMatch(/[\\/]\.manyportals[\\/]config\.json$/)
  })
})

describe('packageVersion — the server must not advertise a placeholder version', () => {
  it('reads the real version from the package.json that ships beside the code', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
    }
    expect(packageVersion()).toBe(manifest.version)
    // The specific regression: every MCP client was told the server was "0.0.0".
    expect(packageVersion()).not.toBe('0.0.0')
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

/** Set env vars for one body, restoring exactly what was there before. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) saved[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    body()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('a leading ~ in an env-var path is expanded (Desktop passes user_config literally)', () => {
  it('expands ~/ in MANYPORTALS_TOKENS_FILE and MANYPORTALS_VAULT_FILE', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined, // vault inactive: nothing is decrypted here
        MANYPORTALS_TOKENS_FILE: '~/no-such-portals/tokens.json',
        MANYPORTALS_VAULT_FILE: '~/no-such-portals/tokens.vault',
      },
      () => {
        const ts = buildTokenSources()
        // join(homedir(), …) rather than a literal '/' — CI also runs windows-latest.
        expect(ts.tokenFilePath).toBe(join(homedir(), 'no-such-portals', 'tokens.json'))
        expect(ts.vaultFilePath).toBe(join(homedir(), 'no-such-portals', 'tokens.vault'))
        expect(ts.tokenFilePath).not.toContain('~')
        expect(ts.vaultFilePath).not.toContain('~')
      },
    )
  })

  it('leaves an already-absolute path untouched, and never expands ~user', () => {
    const absolute = join(homedir(), 'no-such-portals', 'tokens.vault')
    const noTokens = join(homedir(), 'no-such-portals', 'tokens.json')
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_TOKENS_FILE: noTokens,
        MANYPORTALS_VAULT_FILE: absolute,
      },
      () => expect(buildTokenSources().vaultFilePath).toBe(absolute),
    )
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_TOKENS_FILE: '~someone/tokens.json', // another user's home — not ours to resolve
        MANYPORTALS_VAULT_FILE: absolute,
      },
      // Still not expanded: expanded, it would be absolute and pass. Unexpanded it is
      // relative, so #42 refuses it.
      () =>
        expect(() => buildTokenSources()).toThrow(/MANYPORTALS_TOKENS_FILE must be a full path/),
    )
  })
})

describe('a blank or unexpanded env path means "not configured", not a real path', () => {
  // The .mcpb manifest feeds MANYPORTALS_VAULT_FILE from an OPTIONAL user_config
  // field. Left blank it does not arrive as undefined, so `??` alone would keep it
  // and the server would look for a file that cannot exist — and for the vault that
  // is a silent downgrade, because readVaultFile reads ENOENT as "no vault" and
  // resolution drops to the plaintext token file.
  it('falls back to the default vault path when the variable is blank', () => {
    // Pin the token file as the sibling test below does: unpinned, buildTokenSources
    // opens the DEVELOPER's real ~/.manyportals/tokens.json in-process, and this test
    // passes only because that file happens to be absent here. A unit test must not
    // read a credential file at all.
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: '   ',
        MANYPORTALS_TOKENS_FILE: join(homedir(), 'no-such-portals', 'tokens.json'),
      },
      () => {
        const ts = buildTokenSources()
        expect(ts.vaultFilePath).toBe(join(homedir(), '.manyportals', 'tokens.vault'))
      },
    )
  })

  it('falls back when the host passes an unexpanded ${user_config.x} template', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: '${user_config.vault_path}',
        MANYPORTALS_TOKENS_FILE: '${user_config.tokens_path}',
      },
      () => {
        const ts = buildTokenSources()
        expect(ts.vaultFilePath).toBe(join(homedir(), '.manyportals', 'tokens.vault'))
        expect(ts.tokenFilePath).toBe(join(homedir(), '.manyportals', 'tokens.json'))
      },
    )
  })
})

describe('the PASSPHRASE gets the same treatment as the paths (#40 L2)', () => {
  // OBSERVED at a Desktop 0.1.2 install: a user_config field left blank arrives as
  // the literal `${user_config.x}`. #36 made the passphrase field optional, so that
  // shape is now reachable for MANYPORTALS_VAULT_KEY — and read raw it would make an
  // unset vault look ACTIVE with the template as its key.
  const noVault = join(homedir(), 'no-such-portals', 'tokens.vault')
  const noTokens = join(homedir(), 'no-such-portals', 'tokens.json')

  it('treats a blank passphrase as no passphrase — the vault is INACTIVE', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: '   ',
        MANYPORTALS_VAULT_FILE: noVault,
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => expect(buildTokenSources().vaultActive).toBe(false),
    )
  })

  it('treats an unexpanded ${user_config.vault_key} as no passphrase', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: '${user_config.vault_key}',
        MANYPORTALS_VAULT_FILE: noVault,
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => {
        const ts = buildTokenSources()
        // Read raw, this reported vault ACTIVE with a garbage key — and doctor would
        // have said so too, which is the misleading-diagnostic class we keep paying for.
        expect(ts.vaultActive).toBe(false)
      },
    )
  })

  it('still treats a real passphrase as active', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: 'a-real-passphrase',
        MANYPORTALS_VAULT_FILE: noVault,
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => expect(buildTokenSources().vaultActive).toBe(true),
    )
  })

  it('passes the passphrase through RAW, so a padded one still opens its vault', () => {
    // Guards a property that is easy to "tidy" away: vault.ts encrypts with exactly
    // what it is given, so trimming here would silently stop an existing vault from
    // opening. Proven end to end rather than by inspection.
    const dir = mkdtempSync(join(tmpdir(), 'mp-vault-'))
    const vaultPath = join(dir, 'tokens.vault')
    const padded = '  pass phrase  '
    try {
      writeFileSync(vaultPath, encryptVaultTokens({ PORTAL_A: 'tok-a' }, padded), { mode: 0o600 })
      const cfg = loadConfig(
        new FakeConfigProvider({
          portals: { PORTAL_A: { expectedHubId: 111, label: 'Portal A', allowWrite: false } },
          writeMode: 'propose',
        }),
      )
      // portals is a z.record, so indexing yields `T | undefined`. Narrow by asserting
      // the fixture rather than reaching for a non-null assertion: if the fixture ever
      // stops defining this portal, the test should say so, not silently pass.
      const portalA = cfg.portals.PORTAL_A
      if (portalA === undefined) throw new Error('fixture is missing PORTAL_A')
      withEnv(
        {
          MANYPORTALS_VAULT_KEY: padded,
          MANYPORTALS_VAULT_FILE: vaultPath,
          MANYPORTALS_TOKENS_FILE: noTokens,
        },
        () => {
          const ts = buildTokenSources()
          expect(ts.vaultActive).toBe(true)
          expect(ts.presence('PORTAL_A', portalA)).toEqual({ present: true, source: 'vault' })
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the config path is REQUIRED, so it does not share the optional rules (#38)', () => {
  it('fails loud, naming the variable and showing the value, on an unexpanded template', () => {
    withEnv({ MANYPORTALS_CONFIG: '${user_config.config_path}' }, () => {
      // The regression this pins: the template used to resolve to the DEFAULT config —
      // a different portal set than the operator named, reported healthy, exit 0.
      expect(() => resolveConfigPath()).toThrow(SafeError)
      expect(() => resolveConfigPath()).toThrow(/MANYPORTALS_CONFIG/)
      expect(() => resolveConfigPath()).toThrow(/\$\{user_config\.config_path\}/)
    })
  })

  it('fails loud on a ${HOME}/... value too, whatever follows the template', () => {
    withEnv({ MANYPORTALS_CONFIG: '${HOME}/nope/config.json' }, () => {
      expect(() => resolveConfigPath()).toThrow(/MANYPORTALS_CONFIG/)
    })
  })

  it('treats unset, blank and whitespace alike: the default applies', () => {
    for (const blank of [undefined, '', '   ']) {
      withEnv({ MANYPORTALS_CONFIG: blank }, () => {
        expect(resolveConfigPath()).toBe(defaultConfigPath())
      })
    }
  })

  it('expands a leading ~ the way the optional paths do', () => {
    withEnv({ MANYPORTALS_CONFIG: '~/portals/config.json' }, () => {
      // join(homedir(), …) rather than a literal '/' — CI also runs windows-latest.
      expect(resolveConfigPath()).toBe(join(homedir(), 'portals', 'config.json'))
    })
  })

  it('the SAME template is a default for an optional path and a hard failure for the config', () => {
    const template = '${user_config.vault_path}'
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: template,
        MANYPORTALS_TOKENS_FILE: join(homedir(), 'no-such-portals', 'tokens.json'),
        MANYPORTALS_CONFIG: template,
      },
      () => {
        // Optional: unchanged — "not configured" means the default (an unset optional
        // field is normal). Required: never silently substituted.
        expect(buildTokenSources().vaultFilePath).toBe(defaultVaultFilePath())
        expect(() => resolveConfigPath()).toThrow(/MANYPORTALS_CONFIG/)
      },
    )
  })
})

describe.skipIf(process.platform === 'win32')(
  'permission checks fail closed when they cannot look (review 2026-09-27)',
  () => {
    it('warns when a persisted data file exists but its permissions cannot be read', () => {
      // The token-file path cannot reach this: an unreadable token file already fails loudly
      // in readTokenFile with EACCES. The data-file checks only stat, so they are where a
      // failed stat used to read as "absent, nothing to warn about".
      const dir = mkdtempSync(join(tmpdir(), 'mp-perm-'))
      const wall = join(dir, 'wall')
      mkdirSync(wall)
      const dataDir = join(wall, 'data')
      mkdirSync(dataDir)
      writeFileSync(join(dataDir, 'audit.jsonl'), '', { mode: 0o600 })
      chmodSync(wall, 0o000) // the parent is not traversable, so statSync fails with EACCES
      try {
        const warnings = dataFilePermWarnings(dataDir).join('\n')
        expect(warnings).toMatch(/cannot check the permissions/)
        expect(warnings).toMatch(/audit log/)
      } finally {
        chmodSync(wall, 0o700)
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
)

describe('a relative path from the environment is refused, whichever variable carries it (#42)', () => {
  // join() keeps these relative on every OS, including windows-latest in CI.
  const noVault = join(homedir(), 'no-such-portals', 'tokens.vault')
  const noTokens = join(homedir(), 'no-such-portals', 'tokens.json')

  it('refuses a relative vault path instead of reading it as "no vault" and falling through', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: 'a-real-passphrase',
        MANYPORTALS_VAULT_FILE: join('portals', 'tokens.vault'),
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => {
        // Before #42 this returned vaultFileExists: false, and resolution dropped to the
        // plaintext token file with only a non-health note.
        expect(() => buildTokenSources()).toThrow(SafeError)
        expect(() => buildTokenSources()).toThrow(/MANYPORTALS_VAULT_FILE must be a full path/)
        // The value is never quoted: a passphrase pasted into the neighbouring field in
        // Desktop would otherwise be printed on every start.
        expect(() => buildTokenSources()).not.toThrow(/tokens\.vault/)
      },
    )
  })

  it('refuses a relative token-file path', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: noVault,
        MANYPORTALS_TOKENS_FILE: join('portals', 'tokens.json'),
      },
      () => {
        expect(() => buildTokenSources()).toThrow(/MANYPORTALS_TOKENS_FILE must be a full path/)
      },
    )
  })

  it('refuses a relative config path', () => {
    withEnv({ MANYPORTALS_CONFIG: join('portals', 'config.json') }, () => {
      expect(() => resolveConfigPath()).toThrow(SafeError)
      expect(() => resolveConfigPath()).toThrow(/MANYPORTALS_CONFIG must be a full path/)
    })
  })

  /**
   * The vault can be named in the config as well as in the environment (#145). Setup is
   * one folder and one optional passphrase; the Claude Desktop dialog no longer asks for
   * a vault path, because a file picker cannot reach a hidden directory anyway.
   *
   * Two sources for one path, and this REFUSES rather than ranking them. Picking a winner
   * means one silently overrides the other for a credential store, and "read a different
   * vault than you meant" is the worst failure this path has.
   */
  it('takes the vault path declared in the config when the environment is silent', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: undefined,
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => {
        expect(buildTokenSources({ vaultFile: '/tmp/declared/tokens.vault' }).vaultFilePath).toBe(
          '/tmp/declared/tokens.vault',
        )
      },
    )
  })

  it('anchors a RELATIVE vaultFile to the config directory, not to the working directory', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: undefined,
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => {
        const resolved = buildTokenSources({
          vaultFile: 'tokens.vault',
          configDir: '/tmp/mp-config-dir',
        }).vaultFilePath
        expect(resolved).toBe('/tmp/mp-config-dir/tokens.vault')
        // The distinction that makes relative safe HERE and unsafe in an environment
        // variable: cwd differs between Claude Desktop and a shell, the config's own
        // directory does not. Asserting the negative is the half that would catch a
        // regression to resolve-against-cwd, which would pass the line above by luck
        // only when the suite happens to run from the config directory.
        expect(resolved).not.toBe(join(process.cwd(), 'tokens.vault'))
      },
    )
  })

  it('falls back to the default when neither names a vault', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: undefined,
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => {
        expect(buildTokenSources({}).vaultFilePath).toBe(defaultVaultFilePath())
      },
    )
  })

  it('accepts the two naming the same vault, since there is nothing to disagree about', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: '/tmp/agreed/tokens.vault',
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => {
        expect(buildTokenSources({ vaultFile: '/tmp/agreed/tokens.vault' }).vaultFilePath).toBe(
          '/tmp/agreed/tokens.vault',
        )
      },
    )
  })

  it('refuses when the config and the environment name different vaults', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: '/tmp/from-env/tokens.vault',
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => {
        // Both paths are named, so the operator does not have to go and find them.
        expect(() => buildTokenSources({ vaultFile: '/tmp/from-config/tokens.vault' })).toThrow(
          /named twice and the two disagree/,
        )
        expect(() => buildTokenSources({ vaultFile: '/tmp/from-config/tokens.vault' })).toThrow(
          /from-env/,
        )
        expect(() => buildTokenSources({ vaultFile: '/tmp/from-config/tokens.vault' })).toThrow(
          /from-config/,
        )
      },
    )
  })

  it('judges the path AFTER ~ expansion: ~/ passes, ~someone/ (never expanded) is refused', () => {
    withEnv({ MANYPORTALS_CONFIG: '~/portals/config.json' }, () => {
      expect(resolveConfigPath()).toBe(join(homedir(), 'portals', 'config.json'))
    })
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: '~/portals/tokens.vault',
        MANYPORTALS_TOKENS_FILE: noTokens,
      },
      () => {
        expect(buildTokenSources().vaultFilePath).toBe(join(homedir(), 'portals', 'tokens.vault'))
      },
    )
    withEnv({ MANYPORTALS_CONFIG: '~someone/portals/config.json' }, () => {
      expect(() => resolveConfigPath()).toThrow(/must be a full path/)
    })
  })
})

describe('RT-09: vault key set + no vault file → a non-health note', () => {
  it('notes the missing vault (NOT a security warning) so the silent downgrade is visible', () => {
    const saved = {
      key: process.env.MANYPORTALS_VAULT_KEY,
      vault: process.env.MANYPORTALS_VAULT_FILE,
      tokens: process.env.MANYPORTALS_TOKENS_FILE,
    }
    try {
      process.env.MANYPORTALS_VAULT_KEY = 'passphrase'
      process.env.MANYPORTALS_VAULT_FILE = '/no/such/vault.vault'
      process.env.MANYPORTALS_TOKENS_FILE = '/no/such/tokens.json'
      const ts = buildTokenSources()
      expect(ts.notes.join('\n')).toMatch(/no vault file/)
      // a NON-health note, NOT a security warning (must not red-light doctor)
      expect(ts.securityWarnings.join('\n')).not.toMatch(/vault/i)
    } finally {
      for (const [k, v] of [
        ['MANYPORTALS_VAULT_KEY', saved.key],
        ['MANYPORTALS_VAULT_FILE', saved.vault],
        ['MANYPORTALS_TOKENS_FILE', saved.tokens],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

/** Minimal in-memory transport so connect() does not touch real stdio. */
class FakeTransport {
  started = false
  closed = false
  async start(): Promise<void> {
    this.started = true
  }
  async close(): Promise<void> {
    this.closed = true
  }
  async send(): Promise<void> {}
}

const cfg = (hubId: number) =>
  loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: { tokenEnv: 'A', expectedHubId: hubId, label: 'Portal A', allowWrite: true },
      },
      writeMode: 'propose',
    }),
  )

const resolveToken = (k: string) => `tok-${k}`

describe('startServer — composition + boot guard ordering', () => {
  it('runs the boot hub-id assertion, then connects the transport', async () => {
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 111) // matches expected
    const transport = new FakeTransport()
    const out = await startServer({
      config: cfg(111),
      client,
      resolveToken,
      transport: transport as unknown as Transport,
    })
    expect(transport.started).toBe(true)
    expect(out.registry.keys()).toEqual(['PORTAL_A'])
  })

  it('refuses to connect when a token reports the wrong hub id (boot fails first)', async () => {
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 999) // swapped/mislabelled
    const transport = new FakeTransport()
    await expect(
      startServer({
        config: cfg(111),
        client,
        resolveToken,
        transport: transport as unknown as Transport,
      }),
    ).rejects.toThrow()
    // The transport is never connected when the boot guard fails.
    expect(transport.started).toBe(false)
  })
})

describe('dataFilePermWarnings — the check follows the data into the per-copy folders (#24)', () => {
  function withDir(body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'mp-perms-'))
    try {
      body(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('warns about a group/world-readable trail file inside a copy folder', () => {
    if (process.platform === 'win32') return // POSIX modes only
    withDir((dir) => {
      const folder = join(dir, 'audit.d')
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      const file = join(folder, '20260913T101530Z-aaaaaaaa.jsonl')
      writeFileSync(file, '{"a":1}\n', { mode: 0o600 })
      expect(dataFilePermWarnings(dir)).toEqual([]) // owner-only → nothing to say

      chmodSync(file, 0o644) // another local user can now read the trail
      const warnings = dataFilePermWarnings(dir)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/audit log/)
      expect(warnings[0]).toMatch(/20260913T101530Z-aaaaaaaa\.jsonl/)
    })
  })

  it('warns once per folder, however many of its files are readable', () => {
    if (process.platform === 'win32') return
    withDir((dir) => {
      const folder = join(dir, 'id-index.d')
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      for (const name of ['20260913T101530Z-aaaaaaaa.jsonl', '20260913T101600Z-bbbbbbbb.jsonl']) {
        const file = join(folder, name)
        writeFileSync(file, '{"portal":"PORTAL_A","id":"1"}\n')
        chmodSync(file, 0o644)
      }
      expect(dataFilePermWarnings(dir)).toHaveLength(1)
    })
  })

  it('warns when the copy folder itself is group/world-accessible', () => {
    if (process.platform === 'win32') return
    withDir((dir) => {
      const folder = join(dir, 'audit.d')
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      chmodSync(folder, 0o755)
      const warnings = dataFilePermWarnings(dir).join('\n')
      expect(warnings).toMatch(/audit log folder/)
      // A folder needs its execute bit: advising chmod 600 would break it.
      expect(warnings).toMatch(/chmod 700/)
    })
  })

  it('says nothing when the copy folders do not exist yet', () => {
    if (process.platform === 'win32') return
    withDir((dir) => {
      expect(dataFilePermWarnings(dir)).toEqual([])
    })
  })

  it('ignores files that are not trail files, so a stray one cannot fail doctor', () => {
    if (process.platform === 'win32') return
    withDir((dir) => {
      const folder = join(dir, 'audit.d')
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      const stray = join(folder, '.DS_Store') // Finder leaves these, mode 644
      writeFileSync(stray, 'x')
      chmodSync(stray, 0o644)

      // Warning on someone else's file would make doctor exit non-zero forever,
      // since doctorHealthy requires zero security warnings.
      expect(dataFilePermWarnings(dir)).toEqual([])
      expect(trailFileNotes(dir)).toEqual([])
    })
  })

  it('doctor counts the per-copy files, and says nothing when there are none', () => {
    withDir((dir) => {
      expect(trailFileNotes(dir)).toEqual([])

      mkdirSync(join(dir, 'audit.d'), { recursive: true })
      writeFileSync(join(dir, 'audit.d', '20260913T101530Z-aaaaaaaa.jsonl'), '')
      writeFileSync(join(dir, 'audit.d', '20260913T101600Z-bbbbbbbb.jsonl'), '')

      const notes = trailFileNotes(dir)
      expect(notes).toHaveLength(1) // id-index.d does not exist yet
      expect(notes[0]).toMatch(/audit trail: 2 per-copy files in audit\.d\//)
    })
  })
})

/**
 * A credential in the KEY position of the token file reaches the doctor report, and
 * `public/docs/GO-LIVE.md` tells operators that report is safe to paste back to the
 * assistant. So this is a model-visible surface by our own documentation, not only an
 * operator one (#75). Assembled from parts so this file is not a credential-shaped
 * surface itself.
 */
describe('a credential in the token-file key position never reaches the report', () => {
  const TOKEN = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')

  function invertedTokenFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mp-inverted-'))
    const path = join(dir, 'tokens.json')
    // A non-string value is what used to reach the interpolated error; the key check
    // now fires first, so neither branch can echo it.
    writeFileSync(path, JSON.stringify({ [TOKEN]: 123 }))
    return path
  }

  it('fails loudly with the vault inactive, naming neither the key nor a fragment', () => {
    const path = invertedTokenFile()
    withEnv({ MANYPORTALS_VAULT_KEY: undefined, MANYPORTALS_TOKENS_FILE: path }, () => {
      let message = ''
      try {
        buildTokenSources()
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).toContain('inverted')
      expect(message).not.toContain(TOKEN)
      expect(message).not.toContain('0f2e4c6a')
      expect(message).not.toContain('c1d2e3f4a5b6')
    })
  })

  it('carries no token into the security warnings when the vault is active', () => {
    const path = invertedTokenFile()
    const vaultDir = mkdtempSync(join(tmpdir(), 'mp-inverted-vault-'))
    const vaultPath = join(vaultDir, 'tokens.vault')
    writeFileSync(vaultPath, encryptVaultTokens({ PORTAL_A: 'plain-a' }, 'correct horse'), {
      mode: 0o600,
    })
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: 'correct horse',
        MANYPORTALS_VAULT_FILE: vaultPath,
        MANYPORTALS_TOKENS_FILE: path,
      },
      () => {
        let text: string
        try {
          const ts = buildTokenSources()
          text = [...ts.securityWarnings, ...ts.notes].join(' | ')
        } catch (e) {
          text = e instanceof Error ? e.message : String(e)
        }
        expect(text).not.toContain(TOKEN)
        expect(text).not.toContain('0f2e4c6a')
        expect(text).not.toContain('c1d2e3f4a5b6')
      },
    )
  })
})

describe('credential file permissions and env-path integrity', () => {
  it.skipIf(process.platform === 'win32')(
    'warns about a group/world-readable VAULT file (#77)',
    () => {
      // The recommended end state is vault only, plaintext deleted, which was the one
      // configuration with no credential-file permission check at all. The sync on this
      // machine is known to rewrite modes, so 0666 is not hypothetical.
      const dir = mkdtempSync(join(tmpdir(), 'mp-vaultperm-'))
      const vaultPath = join(dir, 'tokens.vault')
      writeFileSync(vaultPath, encryptVaultTokens({ PORTAL_A: 'plain-a' }, 'correct horse'), {
        mode: 0o600,
      })
      chmodSync(vaultPath, 0o666)
      withEnv(
        {
          MANYPORTALS_VAULT_KEY: 'correct horse',
          MANYPORTALS_VAULT_FILE: vaultPath,
          MANYPORTALS_TOKENS_FILE: join(dir, 'no-such-tokens.json'),
        },
        () => {
          const warnings = buildTokenSources().securityWarnings.join(' | ')
          expect(warnings).toContain('vault file')
          expect(warnings).toContain(vaultPath)
        },
      )
    },
  )

  it.skipIf(process.platform === 'win32')(
    'stays quiet about a vault with owner-only permissions',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'mp-vaultperm-ok-'))
      const vaultPath = join(dir, 'tokens.vault')
      writeFileSync(vaultPath, encryptVaultTokens({ PORTAL_A: 'plain-a' }, 'correct horse'), {
        mode: 0o600,
      })
      withEnv(
        {
          MANYPORTALS_VAULT_KEY: 'correct horse',
          MANYPORTALS_VAULT_FILE: vaultPath,
          MANYPORTALS_TOKENS_FILE: join(dir, 'no-such-tokens.json'),
        },
        () => {
          expect(buildTokenSources().securityWarnings.join(' | ')).not.toContain('vault file')
        },
      )
    },
  )

  it('refuses an env path containing a newline, without showing the value (#80)', () => {
    // A newline survives trimming and is rendered verbatim by the setup report, which
    // lets a value forge report lines: a decoy "vault file: ... vault ACTIVE" and an
    // extra "status: healthy".
    const forged = '/tmp/decoy.vault (present; vault ACTIVE)\nstatus: healthy'
    withEnv({ MANYPORTALS_VAULT_KEY: undefined, MANYPORTALS_VAULT_FILE: forged }, () => {
      let message = ''
      try {
        buildTokenSources()
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).toContain('control character')
      expect(message).not.toContain('status: healthy')
      expect(message).not.toContain('decoy')
    })
  })
})

describe('an inactive vault is not a silent downgrade (#79)', () => {
  it('notes a vault file that exists while no passphrase is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-inactive-'))
    const vaultPath = join(dir, 'tokens.vault')
    writeFileSync(vaultPath, encryptVaultTokens({ PORTAL_A: 'plain-a' }, 'correct horse'), {
      mode: 0o600,
    })
    const tokensPath = join(dir, 'tokens.json')
    writeFileSync(tokensPath, JSON.stringify({ PORTAL_A: 'from-the-plaintext-file' }))
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: vaultPath,
        MANYPORTALS_TOKENS_FILE: tokensPath,
      },
      () => {
        const ts = buildTokenSources()
        const text = [...ts.notes, ...ts.securityWarnings].join(' | ')
        expect(text).toContain('INACTIVE')
        expect(text).toContain(vaultPath)
        expect(text).not.toContain('from-the-plaintext-file')
      },
    )
  })

  it('says nothing when there is no vault file at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-novault-'))
    const tokensPath = join(dir, 'tokens.json')
    writeFileSync(tokensPath, JSON.stringify({ PORTAL_A: 'plain-a' }))
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: join(dir, 'no-such.vault'),
        MANYPORTALS_TOKENS_FILE: tokensPath,
      },
      () => {
        expect(buildTokenSources().notes.join(' | ')).not.toContain('INACTIVE')
      },
    )
  })
})

/**
 * The composition root carries the configured write mode into the plan service, and
 * that single line is what makes the shipped `propose` default real. Nothing asserted
 * it: replacing `writeMode: deps.config.writeMode` with a hardcoded `'apply'` left the
 * whole suite green (#85). Every mode-dependent behaviour was tested against
 * hand-built PlanService instances, and the startServer cases only checked that the
 * transport connected.
 */
describe('startServer carries the write mode into the plan service', () => {
  const writableCfg = (portalWriteMode?: 'propose' | 'apply' | 'off') =>
    loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            allowedObjects: ['notes'],
            allowedOperations: ['create'],
            // Listed so apply-mode WOULD auto-execute: without this, apply also
            // requires approval and the two modes are indistinguishable here.
            applyAllowedObjects: ['notes'],
            ...(portalWriteMode === undefined ? {} : { writeMode: portalWriteMode }),
          },
        },
        writeMode: 'propose',
      }),
    )

  async function started(config: ReturnType<typeof writableCfg>) {
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 111)
    const transport = new FakeTransport()
    return startServer({
      config,
      client,
      resolveToken,
      transport: transport as unknown as Transport,
    })
  }

  const note = {
    kind: 'create' as const,
    objectType: 'notes',
    properties: { hs_note_body: 'hello' },
  }

  it('refuses a pre-approval execute when the config says propose', async () => {
    const out = await started(writableCfg())
    const plan = out.plans.draft({ portalKey: 'PORTAL_A', operation: note })
    out.plans.validate(plan.id)
    // Hardcode 'apply' in the composition root and this auto-executes instead.
    await expect(out.plans.execute(plan.id)).rejects.toThrow()
  })

  it('is not confused by a portal named like an Object.prototype member (RT-06)', async () => {
    // `toString` is a legal portal key. A plain-object per-portal map returns the
    // INHERITED function for that lookup instead of falling through to the
    // server-wide mode, so this portal would silently ignore a server-wide `apply`.
    const config = loadConfig(
      new FakeConfigProvider({
        portals: {
          toString: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            allowedObjects: ['notes'],
            allowedOperations: ['create'],
            applyAllowedObjects: ['notes'],
          },
        },
        writeMode: 'apply',
      }),
    )
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-toString', 111)
    const transport = new FakeTransport()
    const out = await startServer({
      config,
      client,
      resolveToken,
      transport: transport as unknown as Transport,
    })
    const plan = out.plans.draft({ portalKey: 'toString', operation: note })
    out.plans.validate(plan.id)
    const executed = await out.plans.execute(plan.id)
    expect(executed.status).toBe('executed')
  })

  it('honours a per-portal writeMode that overrides the server default (#86)', async () => {
    const out = await started(writableCfg('apply'))
    const plan = out.plans.draft({ portalKey: 'PORTAL_A', operation: note })
    out.plans.validate(plan.id)
    // The server default is propose; this portal says apply, and notes are listed in
    // applyAllowedObjects, so the write commits without an approval phrase.
    const executed = await out.plans.execute(plan.id)
    expect(executed.status).toBe('executed')
  })
})
