import { describe, it, expect, vi } from 'vitest'
import { FakeConfigProvider, loadConfig } from '../config/index.js'
import { PortalRegistry } from '../portals/index.js'
import { FakeHubSpotClient } from '../hubspot/fake.js'
import type { HubSpotClient } from '../hubspot/index.js'
import { BootError, assertHubIds } from './index.js'

const resolve = (k: string) => `tok-${k}`
const reg = (portals: Record<string, unknown>) =>
  new PortalRegistry(loadConfig(new FakeConfigProvider({ portals })))

const twoPortals = {
  PORTAL_A: { tokenEnv: 'A', expectedHubId: 111, label: 'Portal A', allowWrite: true },
  PORTAL_B: { tokenEnv: 'B', expectedHubId: 222, label: 'Portal B', allowWrite: true },
}

describe('assertHubIds (swapped-token guard)', () => {
  it('passes when every token reports its expected hub id', async () => {
    const registry = reg(twoPortals)
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 111)
    client.setAccountInfo('tok-PORTAL_B', 222)
    const results = await assertHubIds(registry, client, resolve)
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok'])
  })

  it('throws BootError on a hub-id mismatch, naming the label but NOT the token', async () => {
    const registry = reg(twoPortals)
    const client = new FakeHubSpotClient()
    client.setAccountInfo('tok-PORTAL_A', 222) // swapped: A's token reports B's hub
    client.setAccountInfo('tok-PORTAL_B', 222)
    let caught: unknown
    try {
      await assertHubIds(registry, client, resolve)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(BootError)
    const m = (caught as Error).message
    expect(m).toContain('Portal A')
    expect(m).toContain('expected 111')
    expect(m).not.toContain('tok-') // never the token
  })

  it('skips with a warning when expectedHubId is 0 (unknown)', async () => {
    // A 0 (unknown) hub id is only permitted on a read-only portal (fail-closed:
    // writable portals must have a known hub id).
    const registry = reg({
      PORTAL_A: { tokenEnv: 'A', expectedHubId: 0, label: 'Portal A', allowWrite: false },
    })
    const client = new FakeHubSpotClient() // not seeded — would throw if asserted
    const warn = vi.fn()
    const results = await assertHubIds(registry, client, resolve, warn)
    expect(results[0]?.status).toBe('skipped')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('throws BootError on auth failure (account info unavailable)', async () => {
    const registry = reg({
      PORTAL_A: { tokenEnv: 'A', expectedHubId: 111, label: 'Portal A', allowWrite: true },
    })
    const client = new FakeHubSpotClient() // getAccountInfo will throw
    await expect(assertHubIds(registry, client, resolve)).rejects.toBeInstanceOf(BootError)
  })

  it('fails closed (BootError) on a per-portal timeout instead of hanging (F4)', async () => {
    const registry = reg({
      PORTAL_A: { tokenEnv: 'A', expectedHubId: 111, label: 'Portal A', allowWrite: true },
    })
    // a portal that never responds
    const hanging = {
      getAccountInfo: () => new Promise<never>(() => {}),
    } as unknown as HubSpotClient
    await expect(
      assertHubIds(registry, hanging, resolve, () => {}, { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(BootError)
  })
})
