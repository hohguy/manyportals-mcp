import { describe, it, expect } from 'vitest'
import {
  EnvTokenSource,
  FakeConfigProvider,
  loadConfig,
  type ManyPortalsConfig,
  type PortalConfig,
} from '../config/index.js'
import { buildTokenSources, defaultVaultFilePath } from '../index.js'
import {
  buildDoctorReport,
  doctorHealthy,
  doctorSetupComplete,
  formatDoctorReport,
} from './index.js'

/** Token-presence checker backed by an env map (mirrors the env source). */
const presenceFromEnv =
  (env: Record<string, string>) =>
  (portalKey: string, portal: PortalConfig): { present: boolean; source?: string } => {
    const v = new EnvTokenSource(env).get(portalKey, portal)
    return v !== undefined ? { present: true, source: 'env' } : { present: false }
  }

const config = (): ManyPortalsConfig =>
  loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: {
          tokenEnv: 'HS_A',
          expectedHubId: 111,
          label: 'Portal A',
          allowWrite: true,
          blockedProperties: ['hs_*sensitive*'],
        },
        PORTAL_B: { tokenEnv: 'HS_B', expectedHubId: 0, label: 'Portal B', allowWrite: false },
      },
      writeMode: 'propose',
    }),
  )

const baseCtx = {
  configPath: '/cfg/manyportals.json',
  nodeVersion: 'v22.1.0',
  minNodeMajor: 22,
}

describe('buildDoctorReport — local checks', () => {
  it('reports node, config, portals, and token-env presence (value never read)', () => {
    const report = buildDoctorReport(config(), {
      ...baseCtx,
      tokenPresence: presenceFromEnv({ HS_A: 'pat-na1-SECRET', HS_B: '' }), // A set, B blank
    })
    expect(report.nodeOk).toBe(true)
    expect(report.configOk).toBe(true)
    expect(report.writeModeDefault).toBe('propose')
    const a = report.portals.find((p) => p.key === 'PORTAL_A')!
    const b = report.portals.find((p) => p.key === 'PORTAL_B')!
    expect(a.tokenPresent).toBe(true)
    expect(a.tokenSource).toBe('env')
    expect(a.expectedHubId).toBe(111)
    expect(a.blockedPropertyPatterns).toBe(1)
    expect(b.tokenPresent).toBe(false) // blank env → MISSING
    expect(b.expectedHubId).toBe('unknown') // 0 → unknown
  })

  it('flags an old Node version', () => {
    const report = buildDoctorReport(config(), {
      ...baseCtx,
      nodeVersion: 'v18.19.0',
      tokenPresence: presenceFromEnv({}),
    })
    expect(report.nodeOk).toBe(false)
  })

  it('reports a config load failure gracefully (no portals, configOk false)', () => {
    const report = buildDoctorReport(null, {
      ...baseCtx,
      configError: 'invalid ManyPortals config: portals: at least one portal',
      tokenPresence: presenceFromEnv({}),
    })
    expect(report.configOk).toBe(false)
    expect(report.portals).toHaveLength(0)
    expect(report.configError).toMatch(/at least one portal/)
  })
})

describe('doctorHealthy / doctorSetupComplete (P3.5)', () => {
  it('healthy reflects nothing-wrong; a missing token is incomplete, not unhealthy', () => {
    const ok = buildDoctorReport(config(), {
      ...baseCtx,
      tokenPresence: presenceFromEnv({ HS_A: 'x', HS_B: 'y' }),
    })
    expect(doctorHealthy(ok)).toBe(true)
    expect(doctorSetupComplete(ok)).toBe(true)

    // A tokenless onboarding portal: still HEALTHY (nothing wrong), just not complete —
    // so it doesn't cry wolf with the same status a real security/config problem uses.
    const missingToken = buildDoctorReport(config(), {
      ...baseCtx,
      tokenPresence: presenceFromEnv({ HS_A: 'x' }),
    })
    expect(doctorHealthy(missingToken)).toBe(true)
    expect(doctorSetupComplete(missingToken)).toBe(false)
    expect(formatDoctorReport(missingToken)).toContain('status: setup incomplete')
  })

  it('a security warning is never healthy and is labelled distinctly from setup', () => {
    const warned = buildDoctorReport(config(), {
      ...baseCtx,
      tokenPresence: presenceFromEnv({ HS_A: 'x', HS_B: 'y' }),
      securityWarnings: [
        'SECURITY: token file is group/world-accessible (mode 644): /p/tokens.json',
      ],
    })
    expect(doctorHealthy(warned)).toBe(false)
    expect(formatDoctorReport(warned)).toContain('status: SECURITY WARNING')
  })
})

describe('security warnings (P2.5/P3.5)', () => {
  it('surfaces a loose-token-file warning prominently and fails healthy', () => {
    const report = buildDoctorReport(config(), {
      ...baseCtx,
      tokenPresence: presenceFromEnv({ HS_A: 'x', HS_B: 'y' }), // tokens present, but...
      securityWarnings: [
        'SECURITY: token file is group/world-accessible (mode 644): /p/tokens.json',
      ],
    })
    expect(doctorHealthy(report)).toBe(false) // a security warning is never "healthy"
    const text = formatDoctorReport(report)
    expect(text).toContain('!! SECURITY: token file is group/world-accessible')
  })
})

describe('formatDoctorReport — never prints token values', () => {
  it('shows set/MISSING (+ source) but not the token value', () => {
    const report = buildDoctorReport(config(), {
      ...baseCtx,
      tokenPresence: presenceFromEnv({ HS_A: 'pat-na1-SUPERSECRET', HS_B: 'pat-eu1-OTHER' }),
    })
    const text = formatDoctorReport(report)
    expect(text).toContain('token (env HS_A): set [env]')
    expect(text).not.toContain('pat-') // the value is never rendered
    expect(text).toContain('Portal A')
  })
})

/** Run `fn` with these env vars set (undefined = unset), restoring them afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const k of Object.keys(vars)) saved.set(k, process.env[k])
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('resolved token-source paths (#34)', () => {
  const pathCtx = { ...baseCtx, tokenPresence: presenceFromEnv({ HS_A: 'x', HS_B: 'y' }) }

  it('carries both resolved paths and renders them with the vault state', () => {
    const report = buildDoctorReport(config(), {
      ...pathCtx,
      tokenFilePath: '/opt/portals/tokens.json',
      vaultFilePath: '/opt/portals/tokens.vault',
      vaultFilePresence: 'present',
      vaultActive: true,
    })
    expect(report.tokenFilePath).toBe('/opt/portals/tokens.json')
    expect(report.vaultFilePath).toBe('/opt/portals/tokens.vault')
    const text = formatDoctorReport(report)
    expect(text).toContain('token file: /opt/portals/tokens.json')
    expect(text).toContain('vault file: /opt/portals/tokens.vault (present; vault ACTIVE)')
  })

  it('says not found / INACTIVE for an absent vault with no passphrase', () => {
    const report = buildDoctorReport(config(), {
      ...pathCtx,
      tokenFilePath: '/opt/portals/tokens.json',
      vaultFilePath: '/home/op/.manyportals/tokens.vault',
      vaultFilePresence: 'absent',
      vaultActive: false,
    })
    const text = formatDoctorReport(report)
    expect(text).toContain(
      'vault file: /home/op/.manyportals/tokens.vault (not found; vault INACTIVE)',
    )
  })
})

describe('doctor surfaces this build version (#39)', () => {
  const versionCtx = { ...baseCtx, tokenPresence: presenceFromEnv({ HS_A: 'x', HS_B: 'y' }) }

  it('carries the resolved version and renders it', () => {
    const report = buildDoctorReport(config(), { ...versionCtx, serverVersion: '0.1.2' })
    expect(report.serverVersion).toBe('0.1.2')
    expect(formatDoctorReport(report)).toContain('version 0.1.2')
    expect(doctorHealthy(report)).toBe(true)
  })

  it('reports an unreadable package manifest as a PROBLEM, not a silent green', () => {
    // The layout this catches: a hand-copied dist/ with no package.json beside it.
    // Node still loads it, so doctor used to report healthy on a layout the server
    // refuses to start from.
    const report = buildDoctorReport(config(), {
      ...versionCtx,
      versionError: 'cannot read the package manifest at /opt/portals/package.json',
    })
    expect(doctorHealthy(report)).toBe(false)
    const text = formatDoctorReport(report)
    expect(text).toContain('XX  version: cannot read the package manifest')
    expect(text).toContain('status: PROBLEMS FOUND')
  })
})

describe('buildTokenSources — the paths doctor reports (#34)', () => {
  it('falls back to the default vault path when MANYPORTALS_VAULT_FILE is unset', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: undefined,
        MANYPORTALS_TOKENS_FILE: '/no/such/tokens.json',
      },
      () => {
        const ts = buildTokenSources()
        // The .mcpb bundle's vault-path field is OPTIONAL: left blank, this default is
        // what it really reads — the fact that went unseen and caused the false alarm.
        // Existence is machine-dependent here, so only the PATH is asserted.
        expect(ts.vaultFilePath).toBe(defaultVaultFilePath())
        expect(ts.vaultFilePath).toMatch(/[\\/]\.manyportals[\\/]tokens\.vault$/)
        expect(ts.tokenFilePath).toBe('/no/such/tokens.json')
        expect(ts.vaultActive).toBe(false) // no passphrase → inactive
      },
    )
  })

  it('honours MANYPORTALS_VAULT_FILE when set, and doctor renders that path', () => {
    withEnv(
      {
        MANYPORTALS_VAULT_KEY: undefined,
        MANYPORTALS_VAULT_FILE: '/elsewhere/portals/tokens.vault',
        MANYPORTALS_TOKENS_FILE: '/no/such/tokens.json',
      },
      () => {
        const ts = buildTokenSources()
        expect(ts.vaultFilePath).toBe('/elsewhere/portals/tokens.vault')
        expect(ts.vaultFilePath).not.toBe(defaultVaultFilePath()) // the override won
        expect(ts.vaultFilePresence).toBe('absent') // nothing at the override path
        const text = formatDoctorReport(
          buildDoctorReport(config(), {
            ...baseCtx,
            tokenPresence: presenceFromEnv({ HS_A: 'x', HS_B: 'y' }),
            tokenFilePath: ts.tokenFilePath,
            vaultFilePath: ts.vaultFilePath,
            vaultFilePresence: ts.vaultFilePresence,
            vaultActive: ts.vaultActive,
          }),
        )
        expect(text).toContain('vault file: /elsewhere/portals/tokens.vault')
        expect(text).toContain('token file: /no/such/tokens.json')
        expect(text).not.toMatch(/pat-|passphrase/i) // paths only, never a value
      },
    )
  })
})
