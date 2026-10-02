import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { decryptVaultTokens, encryptVaultTokens } from './config/index.js'

/**
 * Black-box test of the PACKAGED binary (red-team P0.3): build it, spawn it as a
 * real stdio MCP server using the SDK's own client (which performs the genuine
 * initialize handshake), and assert it lists the expected tools. The fixture
 * portal is READ-ONLY with an unknown hub id, so the boot hub-id assertion skips
 * — the server starts with NO live HubSpot calls.
 */
const BIN = join(process.cwd(), 'dist', 'index.js')
let dir: string
let configPath: string

function writeFixtureConfig(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      portals: {
        PORTAL_A: { tokenEnv: 'HS_E2E_A', expectedHubId: 0, label: 'E2E A', allowWrite: false },
      },
      writeMode: 'off',
    }),
  )
}

beforeAll(() => {
  execSync('npm run build', { cwd: process.cwd(), stdio: 'ignore' })
  dir = mkdtempSync(join(tmpdir(), 'mp-e2e-'))
  configPath = join(dir, 'config.json')
  writeFixtureConfig(configPath)
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { ...env, ...extra }
}

describe('black-box MCP stdio (P0.3)', () => {
  it('the built bin initializes over stdio and lists the expected tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: childEnv({ MANYPORTALS_CONFIG: configPath, HS_E2E_A: 'dummy-token' }),
    })
    const client = new Client({ name: 'manyportals-e2e', version: '0' })
    try {
      await client.connect(transport) // real initialize handshake over stdio
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toEqual(
        expect.arrayContaining([
          'list_portals',
          'set_default_read_portal',
          'get_record',
          'search_records',
          'recent_activity',
          'summarize_pipeline',
          'draft_plan',
          'add_note',
          'create_task',
          'log_call',
          'log_meeting',
          'update_deal_stage',
          'validate_plan',
          'inspect_plan_target',
          'show_plan',
          'approve_plan',
          'execute_plan',
          'get_audit_log',
        ]),
      )
    } finally {
      await client.close()
    }
  }, 30_000)

  it('advertises the REAL package version to the client, not the 0.0.0 placeholder', async () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: childEnv({ MANYPORTALS_CONFIG: configPath, HS_E2E_A: 'dummy-token' }),
    })
    const client = new Client({ name: 'manyportals-e2e', version: '0' })
    try {
      await client.connect(transport)
      // What a real client actually receives from the initialize handshake, in the
      // packaged dist layout — package.json one level above dist/index.js, the same
      // shape the installed .mcpb bundle ships.
      const info = client.getServerVersion()
      expect(info?.name).toBe('manyportals-mcp')
      expect(info?.version).toBe(manifest.version)
      expect(info?.version).not.toBe('0.0.0')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('the built bin exits non-zero when the config is missing', () => {
    let code = 0
    try {
      execSync(`"${process.execPath}" "${BIN}" doctor`, {
        env: childEnv({ MANYPORTALS_CONFIG: join(dir, 'does-not-exist.json') }),
        stdio: 'ignore',
      })
    } catch (e) {
      code =
        typeof (e as { status?: number }).status === 'number'
          ? (e as { status: number }).status
          : -1
    }
    expect(code).not.toBe(0)
  })

  it('the built bin exits when its client closes stdin, and takes no lock (#24)', async () => {
    // The MCP stdio shutdown sequence starts with the client closing the server's
    // stdin, and sends SIGTERM only if the server does not exit in reasonable time
    // (spec 2025-06-18, Lifecycle > Shutdown). A client that simply goes away does
    // the same, so the server must exit on its own rather than linger as an orphan.
    // It must also create no lock file: copies now share a data folder, each
    // appending only to its own trail files.
    const ownDir = mkdtempSync(join(tmpdir(), 'mp-e2e-eof-'))
    const ownConfig = join(ownDir, 'config.json')
    writeFixtureConfig(ownConfig)
    const child = spawn(process.execPath, [BIN], {
      env: childEnv({ MANYPORTALS_CONFIG: ownConfig, HS_E2E_A: 'dummy-token' }),
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    try {
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('exit', (code, signal) => resolve({ code, signal }))
        },
      )
      let stdout = ''
      const initialized = new Promise<void>((resolve) => {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
          if (stdout.includes('"id":1')) resolve()
        })
      })
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'manyportals-e2e', version: '0' },
          },
        })}\n`,
      )
      const booted = await Promise.race([
        initialized.then(() => 'initialized' as const),
        exited.then(() => 'exited before initialize' as const),
      ])
      expect(booted).toBe('initialized')

      child.stdin.end() // the client goes away

      const outcome = await Promise.race([
        exited,
        new Promise<'still running after 10s'>((resolve) => {
          setTimeout(() => resolve('still running after 10s'), 10_000).unref()
        }),
      ])
      expect(outcome).toEqual({ code: 0, signal: null })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(ownDir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('operator CLI paths on a fresh machine (sandboxed HOME)', () => {
  /** A throwaway HOME, so `~` resolves into a temp dir and never the real home. */
  function withSandboxHome(body: (home: string) => void): void {
    const home = mkdtempSync(join(tmpdir(), 'mp-home-'))
    try {
      body(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  const MANYPORTALS_VARS = [
    'MANYPORTALS_CONFIG',
    'MANYPORTALS_TOKENS_FILE',
    'MANYPORTALS_VAULT_FILE',
    'MANYPORTALS_VAULT_KEY',
  ]

  /** Run the built bin and capture output whatever the exit code (never throws). */
  function runCli(args: string[], extra: Record<string, string>): { code: number; out: string } {
    const env = childEnv(extra)
    // A stray MANYPORTALS_* in the developer's own shell must not steer the child.
    for (const k of MANYPORTALS_VARS) if (!(k in extra)) delete env[k]
    const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
    return {
      code: typeof r.status === 'number' ? r.status : -1,
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    }
  }

  it('expands a leading ~ in MANYPORTALS_CONFIG', () => {
    withSandboxHome((home) => {
      writeFixtureConfig(join(home, 'config.json'))
      const { out } = runCli(['doctor'], {
        HOME: home,
        USERPROFILE: home, // os.homedir() reads USERPROFILE on Windows
        MANYPORTALS_CONFIG: '~/config.json',
        MANYPORTALS_TOKENS_FILE: join(home, 'no-tokens.json'),
        HS_E2E_A: 'dummy-token',
      })
      // Unexpanded, every fs call fails as "config file not found or unreadable" —
      // the exact onboarding failure this fixes.
      expect(out).not.toMatch(/not found or unreadable/)
      expect(out).toContain(join(home, 'config.json'))
      expect(out).not.toContain('~/config.json')
    })
  }, 30_000)

  it('doctor refuses an unexpanded MANYPORTALS_CONFIG instead of serving the default (#38)', () => {
    withSandboxHome((home) => {
      // A config sits at the DEFAULT path holding a DIFFERENT portal set than the one
      // the operator named. Before the fix, doctor reported THIS one healthy, exit 0 —
      // a silent substitution of the portal set, and the data folder with it.
      mkdirSync(join(home, '.manyportals'), { recursive: true })
      writeFixtureConfig(join(home, '.manyportals', 'config.json'))
      const { code, out } = runCli(['doctor'], {
        HOME: home,
        USERPROFILE: home,
        MANYPORTALS_CONFIG: '${HOME}/nope/config.json',
        HS_E2E_A: 'dummy-token',
      })
      expect(code).not.toBe(0)
      expect(out).toContain('MANYPORTALS_CONFIG')
      expect(out).toContain('${HOME}/nope/config.json') // the offending value is shown
      expect(out).not.toContain('status: healthy')
      expect(out).not.toContain('PORTAL_A') // the default config's portals were never served
    })
  }, 30_000)

  it('doctor refuses a relative config path, and says which variable (#42)', () => {
    withSandboxHome((home) => {
      const { code, out } = runCli(['doctor'], {
        HOME: home,
        USERPROFILE: home,
        MANYPORTALS_CONFIG: join('relative-config-marker', 'config.json'),
        HS_E2E_A: 'dummy-token',
      })
      expect(code).not.toBe(0)
      expect(out).toContain('MANYPORTALS_CONFIG must be a full path')
      expect(out).not.toContain('relative-config-marker') // the value is never printed
      expect(out).not.toContain('status: healthy')
    })
  }, 30_000)

  it('doctor refuses a relative vault path instead of reporting "no vault" (#42)', () => {
    withSandboxHome((home) => {
      writeFixtureConfig(join(home, 'config.json'))
      const { code, out } = runCli(['doctor'], {
        HOME: home,
        USERPROFILE: home,
        MANYPORTALS_CONFIG: join(home, 'config.json'),
        MANYPORTALS_TOKENS_FILE: join(home, 'no-tokens.json'),
        MANYPORTALS_VAULT_FILE: join('relative-vault-marker', 'tokens.vault'),
        HS_E2E_A: 'dummy-token',
      })
      expect(code).not.toBe(0)
      expect(out).toContain('MANYPORTALS_VAULT_FILE must be a full path')
      expect(out).not.toContain('relative-vault-marker')
      expect(out).not.toContain('status: healthy')
    })
  }, 30_000)

  it('doctor reports the version of the build it is running from (#39)', () => {
    withSandboxHome((home) => {
      writeFixtureConfig(join(home, 'config.json'))
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
        version: string
      }
      const { out } = runCli(['doctor'], {
        HOME: home,
        USERPROFILE: home,
        MANYPORTALS_CONFIG: join(home, 'config.json'),
        MANYPORTALS_TOKENS_FILE: join(home, 'no-tokens.json'),
        HS_E2E_A: 'dummy-token',
      })
      expect(out).toContain(`version ${pkg.version}`)
    })
  }, 30_000)

  it('vault encrypt creates its folder owner-only, and never suggests an inline passphrase', () => {
    withSandboxHome((home) => {
      writeFileSync(join(home, 'tokens.json'), JSON.stringify({ PORTAL_A: 'dummy-token' }), {
        mode: 0o600,
      })
      const passphrase = 'test-passphrase-not-a-secret'
      const { code, out } = runCli(['vault', 'encrypt'], {
        HOME: home,
        USERPROFILE: home,
        MANYPORTALS_TOKENS_FILE: '~/tokens.json', // also proves ~ expansion on this path
        MANYPORTALS_VAULT_KEY: passphrase,
      })
      // Before the fix this exited 1: ENOENT, because ~/.manyportals did not exist.
      expect(code).toBe(0)
      expect(existsSync(join(home, '.manyportals', 'tokens.vault'))).toBe(true)
      if (process.platform !== 'win32') {
        const mode = statSync(join(home, '.manyportals')).mode & 0o777
        expect(mode & 0o077).toBe(0) // no group/world access — the folder holds credentials
        expect(mode & 0o700).toBe(0o700)
      }
      // The hint must teach a HIDDEN prompt. `read -rs` without `-p`, because -p is
      // a bash-ism that fails in zsh ("no coprocess") — the operator's shell.
      expect(out).toContain('read -rs MP_KEY')
      expect(out).not.toContain('read -rs -p')
      expect(out).not.toContain('MANYPORTALS_VAULT_KEY=<passphrase>')
      // The passphrase itself is never echoed back to the operator.
      expect(out).not.toContain(passphrase)
    })
  }, 30_000)

  describe('vault add / vault remove change one token (#23)', () => {
    const VAULT_TOKENS = {
      PORTAL_A: 'fixture-token-a-not-real',
      PORTAL_B: 'fixture-token-b-not-real',
    }
    const VAULT_PASS = 'test-passphrase-not-a-secret'

    /** A fixture vault alone in its own folder, so a leftover temp file is visible. */
    function writeFixtureVault(home: string): { vaultDir: string; vaultPath: string } {
      const vaultDir = join(home, 'vault')
      mkdirSync(vaultDir, { mode: 0o700 })
      const vaultPath = join(vaultDir, 'tokens.vault')
      writeFileSync(vaultPath, encryptVaultTokens(VAULT_TOKENS, VAULT_PASS), { mode: 0o600 })
      return { vaultDir, vaultPath }
    }

    function vaultEnv(
      home: string,
      vaultPath: string,
      passphrase = VAULT_PASS,
    ): Record<string, string> {
      return {
        HOME: home,
        USERPROFILE: home,
        MANYPORTALS_VAULT_FILE: vaultPath,
        MANYPORTALS_VAULT_KEY: passphrase,
      }
    }

    /** Every run: no token in the output, and nothing but the vault in its folder. */
    function expectCleanRun(out: string, vaultDir: string): void {
      for (const token of Object.values(VAULT_TOKENS)) expect(out).not.toContain(token)
      expect(out).not.toContain(VAULT_PASS)
      expect(readdirSync(vaultDir)).toEqual(['tokens.vault'])
    }

    it('vault remove PORTAL_B removes that token and keeps PORTAL_A', () => {
      withSandboxHome((home) => {
        const { vaultDir, vaultPath } = writeFixtureVault(home)
        const { code, out } = runCli(['vault', 'remove', 'PORTAL_B'], vaultEnv(home, vaultPath))
        expect(code).toBe(0)
        expect(decryptVaultTokens(readFileSync(vaultPath, 'utf8'), VAULT_PASS)).toEqual({
          PORTAL_A: VAULT_TOKENS.PORTAL_A,
        })
        expect(out).toContain('removed PORTAL_B')
        expect(out).toContain('1 token(s): PORTAL_A')
        expect(out).toContain('restart')
        if (process.platform !== 'win32') {
          expect(statSync(vaultPath).mode & 0o077).toBe(0) // the renamed temp file is owner-only
        }
        expectCleanRun(out, vaultDir)
      })
    }, 30_000)

    it('vault remove of a key that is not in the vault fails and changes nothing', () => {
      withSandboxHome((home) => {
        const { vaultDir, vaultPath } = writeFixtureVault(home)
        const before = readFileSync(vaultPath)
        const { code, out } = runCli(['vault', 'remove', 'PORTAL_C'], vaultEnv(home, vaultPath))
        expect(code).not.toBe(0)
        expect(out).toContain('not in the vault')
        expect(readFileSync(vaultPath).equals(before)).toBe(true)
        expectCleanRun(out, vaultDir)
      })
    }, 30_000)

    it('a wrong passphrase fails and writes nothing', () => {
      withSandboxHome((home) => {
        const { vaultDir, vaultPath } = writeFixtureVault(home)
        const before = readFileSync(vaultPath)
        const wrong = 'wrong-passphrase-not-a-secret'
        const { code, out } = runCli(
          ['vault', 'remove', 'PORTAL_B'],
          vaultEnv(home, vaultPath, wrong),
        )
        expect(code).not.toBe(0)
        expect(out).toContain('decryption failed')
        expect(out).not.toContain(wrong)
        expect(readFileSync(vaultPath).equals(before)).toBe(true)
        expectCleanRun(out, vaultDir)
      })
    }, 30_000)

    it('vault add refuses without a terminal — the token is read only at a hidden prompt', () => {
      withSandboxHome((home) => {
        const { vaultDir, vaultPath } = writeFixtureVault(home)
        const before = readFileSync(vaultPath)
        // spawnSync pipes stdin, so the child has no terminal even with the passphrase set.
        const { code, out } = runCli(['vault', 'add', 'PORTAL_C'], vaultEnv(home, vaultPath))
        expect(code).not.toBe(0)
        expect(out).toContain('no terminal for the token prompt')
        expect(readFileSync(vaultPath).equals(before)).toBe(true)
        expectCleanRun(out, vaultDir)
      })
    }, 30_000)

    it('a token-shaped portal key is refused without being echoed', () => {
      withSandboxHome((home) => {
        const { vaultDir, vaultPath } = writeFixtureVault(home)
        const before = readFileSync(vaultPath)
        // Assembled from parts, NOT a contiguous literal, so the credential scan over
        // src/ stays strict (see src/config/config.test.ts).
        const tokenShaped = ['pat-na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join(
          '-',
        )
        for (const action of ['add', 'remove']) {
          const { code, out } = runCli(['vault', action, tokenShaped], vaultEnv(home, vaultPath))
          expect(code).not.toBe(0)
          expect(out).toContain('looks like a token')
          expect(out).not.toContain(tokenShaped)
          expect(readFileSync(vaultPath).equals(before)).toBe(true)
          expectCleanRun(out, vaultDir)
        }
      })
    }, 30_000)

    it('a token-shaped vault ACTION is refused without being echoed', () => {
      withSandboxHome((home) => {
        const { vaultDir, vaultPath } = writeFixtureVault(home)
        const before = readFileSync(vaultPath)
        // `vault pat-na1-…` puts a token where the action goes. Assembled from parts so
        // the credential scan over src/ stays strict.
        const tokenShaped = ['pat-na1', '5c4b3a29', '8f7e', '6d5c', '4b3a', '291807f6e5d4'].join(
          '-',
        )
        const { code, out } = runCli(['vault', tokenShaped], vaultEnv(home, vaultPath))
        expect(code).not.toBe(0)
        expect(out).toContain('unknown vault action')
        expect(out).toContain('value not shown')
        expect(out).not.toContain(tokenShaped)
        expect(readFileSync(vaultPath).equals(before)).toBe(true)
        expectCleanRun(out, vaultDir)
      })
    }, 30_000)

    it('a token typed after the portal key is refused, not ignored, and not echoed', () => {
      withSandboxHome((home) => {
        const { vaultDir, vaultPath } = writeFixtureVault(home)
        const before = readFileSync(vaultPath)
        // Assembled from parts for the same reason as the test above.
        const tokenShaped = ['pat-na1', '7a6b5c4d', '3e2f', '1a0b', '9c8d', 'e7f6a5b4c3d2'].join(
          '-',
        )
        for (const action of ['add', 'remove']) {
          const { code, out } = runCli(
            ['vault', action, 'PORTAL_A', tokenShaped],
            vaultEnv(home, vaultPath),
          )
          expect(code).not.toBe(0)
          expect(out).toContain('takes one argument')
          expect(out).toContain('shell history')
          expect(out).not.toContain(tokenShaped)
          expect(readFileSync(vaultPath).equals(before)).toBe(true)
          expectCleanRun(out, vaultDir)
        }
      })
    }, 30_000)
  })
})

describe('several copies share one data folder (#24)', () => {
  it('two server processes both serve tools, read each others trails, and take no lock', async () => {
    // The bug this fixes: Claude Desktop starts the server twice, and the
    // one-server lock made the second copy exit. Both copies must now start, and
    // each must see what the other copies wrote. The fixture portal is read-only
    // with an unknown hub id, so neither process makes a live HubSpot call —
    // which is also why the trail below is seeded rather than written by a tool.
    const ownDir = mkdtempSync(join(tmpdir(), 'mp-e2e-copies-'))
    const ownConfig = join(ownDir, 'config.json')
    writeFixtureConfig(ownConfig)

    const otherCopy = '20260101T000000Z-deadbeef'
    mkdirSync(join(ownDir, 'audit.d'), { recursive: true })
    writeFileSync(
      join(ownDir, 'audit.d', `${otherCopy}.jsonl`),
      `${JSON.stringify({
        type: 'draft',
        planId: 'from-another-copy',
        portalKey: 'PORTAL_A',
        at: 2,
        seq: 1,
        writer: otherCopy,
      })}\n`,
    )
    writeFileSync(
      join(ownDir, 'audit.jsonl'), // history from before per-copy files
      `${JSON.stringify({
        type: 'draft',
        planId: 'from-legacy-history',
        portalKey: 'PORTAL_A',
        at: 1,
        seq: 1,
      })}\n`,
    )

    // Owner-only, like the server writes them — otherwise both copies rightly
    // warn about the seeded files and the run fills with SECURITY lines.
    chmodSync(join(ownDir, 'audit.d'), 0o700)
    chmodSync(join(ownDir, 'audit.d', `${otherCopy}.jsonl`), 0o600)
    chmodSync(join(ownDir, 'audit.jsonl'), 0o600)

    const copies = ['copy-one', 'copy-two'].map((name) => ({
      client: new Client({ name, version: '0' }),
      transport: new StdioClientTransport({
        command: process.execPath,
        args: [BIN],
        env: childEnv({ MANYPORTALS_CONFIG: ownConfig, HS_E2E_A: 'dummy-token' }),
      }),
    }))
    try {
      // Both at once: before this change the second one exited on the lock.
      await Promise.all(copies.map((c) => c.client.connect(c.transport)))

      for (const c of copies) {
        const { tools } = await c.client.listTools()
        expect(tools.map((t) => t.name)).toContain('get_audit_log')

        const result = (await c.client.callTool({
          name: 'get_audit_log',
          arguments: { allPortals: true },
        })) as unknown as { content: { text?: string }[] }
        const { events } = JSON.parse(result.content[0]?.text ?? '{}') as {
          events: { planId: string }[]
        }
        // Oldest first: the legacy trail, then the other copy's file.
        expect(events.map((e) => e.planId)).toEqual(['from-legacy-history', 'from-another-copy'])
      }

      expect(existsSync(join(ownDir, 'server.lock'))).toBe(false)
    } finally {
      for (const c of copies) await c.client.close()
      rmSync(ownDir, { recursive: true, force: true })
    }
  }, 60_000)
})
