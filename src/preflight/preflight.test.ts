import { describe, it, expect } from 'vitest'
import { ConfigError, FakeConfigProvider, loadConfig } from '../config/index.js'
import { PortalRegistry } from '../portals/index.js'
import { FakeHubSpotClient } from '../hubspot/fake.js'
import { HubSpotError, type PortalContext } from '../hubspot/index.js'
import { buildPreflightReport, formatPreflightReport } from './index.js'

function setup() {
  const config = loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: { tokenEnv: 'A', expectedHubId: 111, label: 'Portal A', allowWrite: true },
        PORTAL_B: { tokenEnv: 'B', expectedHubId: 222, label: 'Portal B', allowWrite: true },
      },
      writeMode: 'propose',
    }),
  )
  const registry = new PortalRegistry(config)
  const client = new FakeHubSpotClient()
  const resolveToken = (k: string): string => `tok-${k}`
  const ctx = (k: string): PortalContext => ({ token: `tok-${k}`, apiHost: 'api.hubapi.com' })
  return { registry, client, resolveToken, ctx }
}

describe('buildPreflightReport (live read-only checks, on the fake)', () => {
  it('passes a portal whose hub id matches and whose read + pipelines paths work', async () => {
    const { registry, client, resolveToken, ctx } = setup()
    client.setAccountInfo('tok-PORTAL_A', 111) // matches expected
    client.setAccountInfo('tok-PORTAL_B', 222)
    await client.createObject(ctx('PORTAL_A'), 'contacts', { email: 'a@example.com' })
    client.seedPipelines('tok-PORTAL_A', 'deals', [
      { id: 'p', label: 'Sales', stages: [{ id: 's', label: 'New', displayOrder: 0 }] },
    ])

    const report = await buildPreflightReport({ registry, client, resolveToken })
    const a = report.portals.find((p) => p.portalKey === 'PORTAL_A')!
    expect(a.ok).toBe(true)
    expect(a.actualHubId).toBe(111)
    expect(a.checks.every((c) => c.ok)).toBe(true)
  })

  it('flags a hub-id mismatch and a failed read without leaking the token', async () => {
    const { registry, client, resolveToken } = setup()
    client.setAccountInfo('tok-PORTAL_A', 111)
    client.setAccountInfo('tok-PORTAL_B', 999) // expected 222 → mismatch
    client.failSearchFor('tok-PORTAL_B', 'contacts', new HubSpotError('forbidden', 403))

    const report = await buildPreflightReport({ registry, client, resolveToken })
    expect(report.ok).toBe(false)

    const b = report.portals.find((p) => p.portalKey === 'PORTAL_B')!
    expect(b.ok).toBe(false)
    const hubCheck = b.checks.find((c) => c.name === 'hub id')!
    expect(hubCheck.ok).toBe(false)
    expect(hubCheck.detail).toMatch(/does NOT match/)
    const readCheck = b.checks.find((c) => c.name.startsWith('read'))!
    expect(readCheck.ok).toBe(false)

    // The rendered report must never contain a token value.
    const text = formatPreflightReport(report)
    expect(text).not.toContain('tok-')
    expect(text).toContain('PORTAL PROBLEMS')
  })

  it('reports an unauthenticated token as a failed hub-id check (no throw)', async () => {
    const { registry, client, resolveToken } = setup()
    // No setAccountInfo for either → getAccountInfo throws 401; preflight catches it.
    const report = await buildPreflightReport({ registry, client, resolveToken })
    expect(report.ok).toBe(false)
    for (const p of report.portals) {
      expect(p.checks.find((c) => c.name === 'hub id')!.ok).toBe(false)
    }
  })

  it('reports a portal with no token on its own line and still checks the others (#54)', async () => {
    const { registry, client, ctx } = setup()
    client.setAccountInfo('tok-PORTAL_A', 111)
    await client.createObject(ctx('PORTAL_A'), 'contacts', { email: 'a@example.com' })
    client.seedPipelines('tok-PORTAL_A', 'deals', [
      { id: 'p', label: 'Sales', stages: [{ id: 's', label: 'New', displayOrder: 0 }] },
    ])
    // PORTAL_B has no token: resolution throws, exactly as the real token sources do.
    const resolveToken = (k: string): string => {
      if (k === 'PORTAL_B') throw new ConfigError('no token for portal "PORTAL_B"')
      return `tok-${k}`
    }

    // Before #54 this promise rejected, and no portal got a result.
    const report = await buildPreflightReport({ registry, client, resolveToken })
    expect(report.ok).toBe(false)
    expect(report.portals.find((p) => p.portalKey === 'PORTAL_A')!.ok).toBe(true)
    const b = report.portals.find((p) => p.portalKey === 'PORTAL_B')!
    expect(b.ok).toBe(false)
    expect(b.checks).toEqual([
      { name: 'token', ok: false, detail: 'no token for portal "PORTAL_B"' },
    ])
    expect(formatPreflightReport(report)).toContain('PORTAL PROBLEMS')
  })
})

describe('preflight blocked-property coverage (a dead pattern blocks nothing)', () => {
  it('flags a blockedProperties pattern that matches no contact property', async () => {
    const config = loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            blockedProperties: ['*ssn*', 'emial'], // '*ssn*' matches ssn_number; 'emial' is a typo → dead
          },
        },
        writeMode: 'propose',
      }),
    )
    const registry = new PortalRegistry(config)
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 111)
    client.seedProperties('tok-PORTAL_A', 'contacts', ['email', 'ssn_number', 'firstname'])

    const report = await buildPreflightReport({ registry, client, resolveToken: (k) => `tok-${k}` })
    const cov = report.portals[0]!.checks.find((c) => c.name === 'blocked-property coverage')!
    expect(cov.detail).toContain('emial') // the dead (typo'd) pattern is surfaced
    expect(cov.detail).toContain('⚠')
    expect(report.portals[0]!.ok).toBe(true) // advisory — does not fail preflight
  })

  it('reports full coverage when every pattern matches a real property', async () => {
    const config = loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            blockedProperties: ['*ssn*', 'email'],
          },
        },
        writeMode: 'propose',
      }),
    )
    const registry = new PortalRegistry(config)
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 111)
    client.seedProperties('tok-PORTAL_A', 'contacts', ['email', 'ssn_number'])

    const report = await buildPreflightReport({ registry, client, resolveToken: (k) => `tok-${k}` })
    const cov = report.portals[0]!.checks.find((c) => c.name === 'blocked-property coverage')!
    expect(cov.detail).toContain('all 2 pattern(s) match')
    expect(cov.detail).not.toContain('⚠')
  })
})

describe('blocked-property coverage cannot report PASSED when it could not look (#111)', () => {
  /** A portal that configures blockedProperties, so the check actually runs. */
  function withPatterns() {
    return loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            blockedProperties: ['*ssn*'],
          },
        },
        writeMode: 'propose',
      }),
    )
  }

  it('fails the portal when the property read is refused, like its three siblings do', async () => {
    // Was `ok: true` with detail "skipped". A 403 from a missing scope produced ALL
    // PORTALS PASSED, and the operator went live believing a typo'd blocklist had
    // been verified. The three checks above it all push ok:false on error.
    const registry = new PortalRegistry(withPatterns())
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 111)
    client.failPropertiesFor(
      'tok-PORTAL_A',
      'contacts',
      new HubSpotError('missing the crm.schemas.contacts.read scope', 403),
    )

    const report = await buildPreflightReport({ registry, client, resolveToken: (k) => `tok-${k}` })
    const cov = report.portals[0]!.checks.find((c) => c.name === 'blocked-property coverage')!
    expect(cov.ok).toBe(false)
    expect(cov.detail).toContain('NOT verified')
    expect(report.portals[0]!.ok).toBe(false)
    expect(formatPreflightReport(report)).not.toContain('ALL PORTALS PASSED')
  })

  it('still passes when the read succeeds and every pattern matches', async () => {
    // The control: without it, the case above is satisfied by failing on everything.
    const registry = new PortalRegistry(withPatterns())
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 111)
    client.seedProperties('tok-PORTAL_A', 'contacts', ['email', 'ssn_number'])

    const report = await buildPreflightReport({ registry, client, resolveToken: (k) => `tok-${k}` })
    const cov = report.portals[0]!.checks.find((c) => c.name === 'blocked-property coverage')!
    expect(cov.ok).toBe(true)
    expect(cov.detail).toContain('all 1 pattern(s) match')
  })
})
