import type { HubSpotClient, PortalContext } from '../hubspot/index.js'
import type { PortalRegistry } from '../portals/index.js'
import { SafeError } from '../errors/index.js'
import { mapBounded } from '../util/index.js'

export class BootError extends SafeError {
  constructor(message: string) {
    super(message)
    this.name = 'BootError'
  }
}

export interface HubIdResult {
  portalKey: string
  label: string
  status: 'ok' | 'skipped'
  expectedHubId: number
  actualHubId?: number
}

/** Reject after `ms` so one slow/down portal cannot hang boot indefinitely (F4). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/**
 * Boot-time hub-id assertion (the swapped-token guard).
 *
 * For each portal, fetch the token's account info and assert the returned
 * portalId equals the configured `expectedHubId`. An `expectedHubId` of 0 means
 * "unknown" → the assertion is SKIPPED with a warning (never asserted == 0). A
 * mismatch, auth failure, or per-portal timeout throws `BootError` naming only
 * the portal label and key — never the token.
 *
 * Portals are checked CONCURRENTLY with a per-portal timeout (F4): boot latency
 * no longer grows linearly with N, and one unreachable portal cannot hang
 * startup forever — it fails closed (refuse to start) after the timeout.
 */
export async function assertHubIds(
  registry: PortalRegistry,
  client: HubSpotClient,
  resolveToken: (portalKey: string) => string,
  warn: (message: string) => void = () => {},
  opts?: { timeoutMs?: number; concurrency?: number },
): Promise<HubIdResult[]> {
  const timeoutMs = opts?.timeoutMs ?? 10_000
  const concurrency = opts?.concurrency ?? 8
  return mapBounded(registry.keys(), concurrency, async (key): Promise<HubIdResult> => {
    const portal = registry.get(key)
    const ctx: PortalContext = { token: resolveToken(key), apiHost: portal.apiHost }

    if (portal.expectedHubId === 0) {
      warn(
        `portal "${portal.label}" (${key}) has no expected hub id configured; skipping hub-id assertion`,
      )
      return { portalKey: key, label: portal.label, status: 'skipped', expectedHubId: 0 }
    }

    let actual: number
    try {
      actual = (await withTimeout(client.getAccountInfo(ctx), timeoutMs)).portalId
    } catch {
      // Never surface the caught error (it could carry request detail / be a timeout); label only.
      throw new BootError(
        `hub-id check failed for portal "${portal.label}" (${key}): could not fetch account info (auth/connectivity/timeout)`,
      )
    }

    if (actual !== portal.expectedHubId) {
      throw new BootError(
        `hub-id mismatch for portal "${portal.label}" (${key}): expected ${portal.expectedHubId}, got ${actual} — refusing to start (possible swapped or mislabelled token)`,
      )
    }

    return {
      portalKey: key,
      label: portal.label,
      status: 'ok',
      expectedHubId: portal.expectedHubId,
      actualHubId: actual,
    }
  })
}
