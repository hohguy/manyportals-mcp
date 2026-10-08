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

  /**
   * THE HEADING TEST for SAFETY.md's "A startup check catches a swapped token wherever you
   * set a hub ID." (#202), registered in scripts/claims-register.json.
   *
   * "Wherever" is the word under test, so this enumerates the swap POSITIONS rather than
   * swapping the first two portals and calling it proven. The earlier heading could not
   * carry a test at all, which is why #202 reworded it: a swap between two portals that
   * both leave the hub id unknown is NOT caught, and that case is the body's own sentence
   * with its own test below it. Here the quantifier is exactly "a pair in which at least
   * one portal has a hub id configured", and every such pair is tried.
   *
   * The unswapped baseline runs first. Without it a BootError thrown for some unrelated
   * reason — an unseeded token, a config the loader rejects — would read as the guard
   * working, which is the shape of a guard that cannot fail (#124).
   */
  it('catches a swap in every position where a hub id is configured', async () => {
    const hubIdOf: Record<string, number> = {
      PORTAL_A: 111,
      PORTAL_B: 222,
      PORTAL_C: 0, // read-only, hub id left unknown
      PORTAL_D: 0, // read-only, hub id left unknown
    }
    const portals = Object.fromEntries(
      Object.entries(hubIdOf).map(([key, expectedHubId]) => [
        key,
        {
          tokenEnv: key.slice(-1),
          expectedHubId,
          label: `Portal ${key.slice(-1)}`,
          // A 0 (unknown) hub id is only permitted on a read-only portal.
          allowWrite: expectedHubId !== 0,
        },
      ]),
    )
    // What each token really reports, including the two nobody checks.
    const reports: Record<string, number> = {
      PORTAL_A: 111,
      PORTAL_B: 222,
      PORTAL_C: 333,
      PORTAL_D: 444,
    }
    const seeded = (): FakeHubSpotClient => {
      const client = new FakeHubSpotClient()
      for (const [key, id] of Object.entries(reports)) client.setAccountInfo(`tok-${key}`, id)
      return client
    }
    const swap =
      (x: string, y: string) =>
      (key: string): string =>
        `tok-${key === x ? y : key === y ? x : key}`

    const keys = Object.keys(hubIdOf)
    const pairs = keys.flatMap((a, i) => keys.slice(i + 1).map((b) => [a, b] as const))
    const withAHubId = pairs.filter(([a, b]) => hubIdOf[a] !== 0 || hubIdOf[b] !== 0)
    const label = ([a, b]: readonly [string, string]): string => `${a}<->${b}`

    // NON-VACUITY. An empty or short list of positions would make the loop below prove
    // nothing at all, so the positions are named before they are exercised.
    expect(withAHubId.map(label)).toEqual([
      'PORTAL_A<->PORTAL_B',
      'PORTAL_A<->PORTAL_C',
      'PORTAL_A<->PORTAL_D',
      'PORTAL_B<->PORTAL_C',
      'PORTAL_B<->PORTAL_D',
    ])
    const baseline = await assertHubIds(reg(portals), seeded(), resolve, () => {})
    expect(baseline.map((r) => r.status)).toEqual(['ok', 'ok', 'skipped', 'skipped'])

    const caught: string[] = []
    for (const pair of withAHubId) {
      try {
        await assertHubIds(reg(portals), seeded(), swap(pair[0], pair[1]), () => {})
      } catch (e) {
        if (e instanceof BootError) caught.push(label(pair))
      }
    }
    expect(caught, 'these swaps were NOT caught').toEqual(withAHubId.map(label))
  })

  /**
   * The carve-out the bullet discloses, and the reason its heading says "wherever you set a
   * hub ID" (#202). Registered in scripts/claims-register.json.
   *
   * The client is left UNSEEDED on purpose: `getAccountInfo` throws for any token it has
   * not been given, so if the check ran at all this would raise a BootError. Not throwing
   * is therefore evidence of the skip rather than evidence of a pass, and `calls` being
   * empty says the same thing from the other side.
   */
  it('two read-only portals that both leave the hub id unknown can swap tokens unnoticed', async () => {
    const registry = reg({
      PORTAL_C: { tokenEnv: 'C', expectedHubId: 0, label: 'Portal C', allowWrite: false },
      PORTAL_D: { tokenEnv: 'D', expectedHubId: 0, label: 'Portal D', allowWrite: false },
    })
    const client = new FakeHubSpotClient() // unseeded: a check that RAN would throw
    const swapped = (key: string): string => `tok-${key === 'PORTAL_C' ? 'PORTAL_D' : 'PORTAL_C'}`

    const results = await assertHubIds(registry, client, swapped, () => {})
    expect(results, 'no portal was examined, so this proves nothing').toHaveLength(2)
    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped'])
    expect(client.calls, 'a token was consulted, so the check did not skip').toEqual([])
  })
})
