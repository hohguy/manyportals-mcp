import type { HubSpotClient, PortalContext } from '../hubspot/index.js'
import type { PortalRegistry } from '../portals/index.js'
import { publicErrorMessage } from '../errors/index.js'
import { matchBlockedProperties } from '../safety/index.js'
import { mapBounded } from '../util/index.js'

/**
 * Operator-run LIVE preflight (the stage-6 gate). Unlike `doctor` (local only),
 * this makes real, READ-ONLY HubSpot calls to confirm — per portal — that the
 * token reaches the right hub, that read scope works, and that the two
 * preflight-gated read paths (search+sorts, /crm/v3/pipelines) are reachable.
 *
 * Token boundary: the token is used only in the Authorization header (inside the
 * client) and NEVER appears in the report. Every check detail is a sanitized
 * string (hub id, counts, or a `publicErrorMessage` — method/path/status only,
 * never a body). The whole report is safe to share back to the model/operator.
 *
 * NOT covered here: WRITE scopes and the association/object write paths. Writes
 * must go through the plan lifecycle (and would create real records), so the
 * operator verifies them with one real mediated write per the runbook
 * (docs/GO-LIVE.md), not this harness.
 */
export interface PreflightCheck {
  name: string
  ok: boolean
  /** Sanitized — never a token, never a response body. */
  detail: string
}

export interface PortalPreflight {
  portalKey: string
  label: string
  expectedHubId: number | 'unknown'
  actualHubId?: number
  checks: PreflightCheck[]
  ok: boolean
}

export interface PreflightReport {
  portals: PortalPreflight[]
  ok: boolean
}

export interface PreflightDeps {
  registry: PortalRegistry
  client: HubSpotClient
  resolveToken: (portalKey: string) => string
  /** Bound the simultaneous live calls across portals (L1). */
  concurrency?: number
}

async function preflightPortal(deps: PreflightDeps, key: string): Promise<PortalPreflight> {
  const portal = deps.registry.get(key)
  const expectedHubId = portal.expectedHubId === 0 ? 'unknown' : portal.expectedHubId
  // The token is resolved INSIDE this portal's report, like every check below (#54). A
  // portal with no token throws here, and outside a try that throw rejected the whole
  // run: one portal without a token hid every other portal's result.
  let token: string
  try {
    token = deps.resolveToken(key)
  } catch (e) {
    return {
      portalKey: key,
      label: portal.label,
      expectedHubId,
      checks: [{ name: 'token', ok: false, detail: publicErrorMessage(e) }],
      ok: false,
    }
  }
  const ctx: PortalContext = { token, apiHost: portal.apiHost }
  const checks: PreflightCheck[] = []
  let actualHubId: number | undefined

  // 1. account-info → hub id (the swapped-token guard, reported non-fatally here).
  try {
    const info = await deps.client.getAccountInfo(ctx)
    actualHubId = info.portalId
    if (portal.expectedHubId === 0) {
      checks.push({
        name: 'hub id',
        ok: true,
        detail: `connected; hub id ${info.portalId} (expected: unknown — not asserted)`,
      })
    } else if (info.portalId === portal.expectedHubId) {
      checks.push({
        name: 'hub id',
        ok: true,
        detail: `hub id ${info.portalId} matches expected`,
      })
    } else {
      checks.push({
        name: 'hub id',
        ok: false,
        detail: `hub id ${info.portalId} does NOT match expected ${portal.expectedHubId} — possible swapped/mislabelled token`,
      })
    }
  } catch (e) {
    checks.push({ name: 'hub id', ok: false, detail: publicErrorMessage(e) })
  }

  // 2. read scope + the 2026-03 search path + the `sorts` directive.
  try {
    const r = await deps.client.searchObjects(ctx, 'contacts', {
      limit: 1,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    })
    checks.push({
      name: 'read (search contacts, sorted)',
      ok: true,
      detail: `ok — ${r.total} contact(s) match; search + sorts path reachable`,
    })
  } catch (e) {
    checks.push({
      name: 'read (search contacts, sorted)',
      ok: false,
      detail: publicErrorMessage(e),
    })
  }

  // 3. the /crm/v3/pipelines path used by summarize_pipeline.
  try {
    const pipelines = await deps.client.getPipelines(ctx, 'deals')
    const stages = pipelines.reduce((n, p) => n + p.stages.length, 0)
    checks.push({
      name: 'pipelines (deals)',
      ok: true,
      detail: `ok — ${pipelines.length} pipeline(s), ${stages} stage(s); /crm/v3/pipelines path reachable`,
    })
  } catch (e) {
    checks.push({ name: 'pipelines (deals)', ok: false, detail: publicErrorMessage(e) })
  }

  // 4. blocked-property coverage (safety): a `blockedProperties` pattern that matches
  //    NO real property silently blocks nothing (the R3.G class). Check each pattern
  //    against the portal's CONTACT property names (the primary PII object) and flag
  //    any that match none. Advisory (a pattern may legitimately target another object
  //    type, so it does not fail preflight), but surfaced so a typo can't hide a dead
  //    control.
  if (portal.blockedProperties.length > 0) {
    try {
      const props = await deps.client.getProperties(ctx, 'contacts')
      const dead = portal.blockedProperties.filter(
        (p) => matchBlockedProperties([p], props).length === 0,
      )
      checks.push({
        name: 'blocked-property coverage',
        ok: true,
        detail:
          dead.length === 0
            ? `all ${portal.blockedProperties.length} pattern(s) match a contacts property`
            : `⚠ pattern(s) matched NO contacts property — a dead pattern blocks nothing; verify spelling (or ignore if intended for another object type): ${dead.join(', ')}`,
      })
    } catch (e) {
      // Was `ok: true`, inverted relative to the three siblings above. A 403 or a 429
      // produced ALL PORTALS PASSED, and the operator proceeded believing a typo'd
      // blocklist had been verified (#111).
      checks.push({
        name: 'blocked-property coverage',
        ok: false,
        detail: `could not read contact properties, so the blockedProperties patterns were NOT verified (${publicErrorMessage(e)})`,
      })
    }
  }

  return {
    portalKey: key,
    label: portal.label,
    expectedHubId,
    actualHubId,
    checks,
    ok: checks.every((c) => c.ok),
  }
}

/** Run the live read-only preflight for every configured portal (bounded concurrency). */
export async function buildPreflightReport(deps: PreflightDeps): Promise<PreflightReport> {
  const portals = await mapBounded(deps.registry.keys(), deps.concurrency ?? 6, (key) =>
    preflightPortal(deps, key),
  )
  return { portals, ok: portals.every((p) => p.ok) }
}

/** Render the report as operator-facing text. Contains no token values. */
export function formatPreflightReport(report: PreflightReport): string {
  const mark = (ok: boolean): string => (ok ? 'OK ' : 'XX ')
  const lines: string[] = []
  lines.push('manyportals-mcp preflight (LIVE HubSpot checks — READ-ONLY)')
  lines.push(
    'note: write scopes are NOT exercised here — verify with one real mediated write per docs/GO-LIVE.md',
  )
  for (const p of report.portals) {
    const actual = p.actualHubId !== undefined ? ` actualHubId=${p.actualHubId}` : ''
    lines.push(
      `${mark(p.ok)} ${p.portalKey} (${p.label})  expectedHubId=${p.expectedHubId}${actual}`,
    )
    for (const c of p.checks) lines.push(`     ${mark(c.ok)} ${c.name}: ${c.detail}`)
  }
  lines.push(
    report.ok
      ? 'status: ALL PORTALS PASSED (read-only checks) — proceed to the mediated-write test'
      : 'status: PORTAL PROBLEMS — see the XX lines above',
  )
  return lines.join('\n')
}
