import type { HubSpotClient, HubSpotObject, PortalContext, SearchBody } from '../hubspot/index.js'
import { HubSpotError } from '../hubspot/index.js'
import type { PortalConfig } from '../config/index.js'
import type { PortalRegistry } from '../portals/index.js'
import { matchBlockedProperties, type PortalIdIndex } from '../safety/index.js'
import { SafeError } from '../errors/index.js'
import { compareValues, mapBounded } from '../util/index.js'

/** Standard HubSpot engagement (activity) object types, queried by recent_activity. */
export const DEFAULT_ACTIVITY_TYPES = ['notes', 'calls', 'emails', 'meetings', 'tasks'] as const
/** Property used to order activity records by recency (universal last-modified timestamp). */
const ACTIVITY_SORT_PROPERTY = 'hs_lastmodifieddate'
/**
 * Cap on simultaneous HubSpot SEARCH calls a single read tool may fan out
 * (L1/F-R3.1, then #47).
 *
 * Search has its own, much tighter budget than the general APIs: HubSpot raised the
 * search burst limit to 5/sec on 2024-09-23, but only for Professional/Enterprise
 * (or the API Limit Increase pack) — Free and Starter portals stay at 4/sec. A client
 * portal may be on any tier, so 4/sec is the FLOOR, and 3 sits deliberately below it
 * rather than on it. The previous shared cap of 6 meant a default 7-stage deal
 * pipeline 429'd deterministically while a 4-stage ticket pipeline worked.
 *
 * This is a BURST cap, not a rate limiter: with fast responses the pool loops and can
 * still issue more than 3 calls in a second. The real fix for a 429 is the bounded,
 * `Retry-After`-honouring retry on idempotent reads in `HttpHubSpotClient` (#48); this
 * cap only narrows the window.
 *
 * Scoped to SEARCH fan-outs on purpose: a future non-search read fan-out is on the
 * ordinary (much larger) budget and must not inherit this number.
 */
const SEARCH_FANOUT_CONCURRENCY = 3
/** Cap on the number of object types recent_activity will scan in one call. */
const MAX_ACTIVITY_TYPES = 20

/**
 * Classify a failed per-type read so a real operational failure (auth/scope, rate
 * limit) is not mislabeled as "type not present in the portal" (L4/F-R3.C). The
 * reason is a coarse, non-sensitive class — never the raw error or any body.
 */
function classifyReadFailure(e: unknown): string {
  if (e instanceof HubSpotError) {
    if (e.status === 401 || e.status === 403) return 'auth/permission'
    if (e.status === 429) return 'rate-limited'
    if (e.status === 404 || e.status === 400) return 'not-found'
  }
  return 'error'
}

export class ReadError extends SafeError {
  constructor(message: string) {
    super(message)
    this.name = 'ReadError'
  }
}

export interface ReadServiceDeps {
  registry: PortalRegistry
  client: HubSpotClient
  idIndex: PortalIdIndex
  /** Resolve a portal's token (kept out of results; injected from the config layer). */
  resolveToken: (portalKey: string) => string
}

export interface GetRecordInput {
  /** Optional: reads may use the selected default portal; omit to use it. */
  portalKey?: string
  objectType: string
  objectId: string
  properties?: string[]
}

/** A single structured search condition. propertyName is screened like a requested property. */
export interface ReadFilter {
  propertyName: string
  operator: string
  value?: string
}

export interface SearchRecordsInput {
  portalKey?: string
  objectType: string
  /** Structured filters (AND'd into one HubSpot filterGroup). No opaque passthrough (P1.2). */
  filters?: ReadFilter[]
  properties?: string[]
  limit?: number
}

export interface RecentActivityInput {
  portalKey?: string
  /** Activity object types to scan; defaults to the standard engagement types. */
  objectTypes?: string[]
  /** Extra properties to return (screened); the sort timestamp is always included. */
  properties?: string[]
  /** Max activities returned across all types (default 10). */
  limit?: number
}

/**
 * Pipeline-bearing object types and their pipeline/stage property names.
 * Doc-verified: deals use `pipeline`/`dealstage`; tickets use
 * `hs_pipeline`/`hs_pipeline_stage` (HubSpot Tickets API guide).
 */
const PIPELINE_OBJECT_TYPES = {
  deals: { pipelineProperty: 'pipeline', stageProperty: 'dealstage' },
  tickets: { pipelineProperty: 'hs_pipeline', stageProperty: 'hs_pipeline_stage' },
} as const
export type PipelineObjectType = keyof typeof PIPELINE_OBJECT_TYPES

export interface SummarizePipelineInput {
  portalKey?: string
  /** 'deals' (default) or 'tickets'. */
  objectType?: PipelineObjectType
  /** Pipeline id; defaults to the portal's first pipeline for the object type. */
  pipelineId?: string
}

/** Every read echoes the portal it actually hit, so a wrong-portal default is visible. */
export interface GetRecordResult {
  portalKey: string
  label: string
  record: HubSpotObject
}

export interface SearchRecordsResult {
  portalKey: string
  label: string
  total: number
  records: HubSpotObject[]
}

export interface RecentActivityItem {
  objectType: string
  record: HubSpotObject
}

/** An activity type whose search failed, with WHY (so auth/rate errors aren't read as absence). */
export interface UnavailableActivityType {
  objectType: string
  /** 'not-found' | 'auth/permission' | 'rate-limited' | 'error' — a coarse, non-sensitive class. */
  reason: string
}

export interface RecentActivityResult {
  portalKey: string
  label: string
  activities: RecentActivityItem[]
  /** Types whose search failed — dropped from the merge, not fatal. Reason distinguishes
   * genuine absence ('not-found') from an operational signal ('auth/permission'/'rate-limited'). */
  unavailableTypes: UnavailableActivityType[]
}

export interface PipelineStageSummary {
  stageId: string
  label: string
  count: number
}

export interface SummarizePipelineResult {
  portalKey: string
  label: string
  /** Which pipeline-bearing object type was summarized ('deals' or 'tickets'). */
  objectType: PipelineObjectType
  pipeline: { id: string; label: string }
  stages: PipelineStageSummary[]
  totalCount: number
}

/**
 * The curated, safe READ surface (AR-2: reads are exposed; writes never are).
 *
 * Two safety invariants live here so no individual tool can forget them:
 *  1. Index population — every returned record id is attributed to the resolved
 *     portal in the `PortalIdIndex`, feeding the cross-portal contamination guard
 *     (red-team P2: reads are how the index learns ownership).
 *  2. Blocked-property screen — an explicit `properties` request is rejected if it
 *     names a portal-blocked field (`screen`), AND any blocked field HubSpot
 *     returns by default is stripped from the RESULT (`screenReturned`, R4.2) — so
 *     `blockedProperties` governs what a read SURFACES, not only what it requests.
 *     This screen does NOT cover HubSpot's own sensitivity marking. An earlier
 *     comment here claimed flagged values were never returned because the client
 *     never sends `dataSensitivity=sensitive`; that selector lists property
 *     DEFINITIONS and is not required to read a VALUE, so the inference was invalid
 *     (#261/#262, corrected 2026-10-07). Sensitive values are gated by the token's
 *     `…sensitive.*` scopes: without one HubSpot documents a 403, with one the value
 *     is returned here like any other. #263 decides whether that should change.
 *
 * Reads may use the selected default portal (resolveForRead); writes never do.
 */
export class ReadService {
  constructor(private readonly d: ReadServiceDeps) {}

  private screen(blockedProperties: readonly string[], requested: string[] | undefined): void {
    const blocked = matchBlockedProperties(blockedProperties, requested ?? [])
    if (blocked.length > 0) {
      throw new ReadError(
        `blocked (sensitive) propert${blocked.length > 1 ? 'ies' : 'y'} not readable: ${blocked.join(', ')}`,
      )
    }
  }

  /**
   * Remove any RETURNED property whose name matches a blocked (sensitive) pattern.
   * `screen()` rejects a blocked field the caller explicitly REQUESTS; this strips a
   * blocked field HubSpot returns by DEFAULT when no `properties` were requested —
   * so `blockedProperties` governs what reads surface, not only what they ask for
   * (R4.2: closes the request-side-only read gap). The record id is untouched.
   */
  private screenReturned(
    blockedProperties: readonly string[],
    record: HubSpotObject,
  ): HubSpotObject {
    const blocked = new Set(
      matchBlockedProperties(blockedProperties, Object.keys(record.properties)),
    )
    if (blocked.size === 0) return record
    const properties = Object.fromEntries(
      Object.entries(record.properties).filter(([k]) => !blocked.has(k)),
    )
    return { ...record, properties }
  }

  /**
   * Resolve the portal for a read AND enforce the per-portal read switch (allowRead).
   * A parked portal (allowRead=false) refuses every read tool here; internal preflight
   * reads in the plan layer do not go through this path and are unaffected.
   */
  private resolveReadable(portalKey: string | undefined): { key: string; portal: PortalConfig } {
    const resolved = this.d.registry.resolveForRead(portalKey)
    if (!resolved.portal.allowRead) {
      throw new ReadError(`reads are disabled for portal "${resolved.key}" (allowRead=false)`)
    }
    return resolved
  }

  async getRecord(input: GetRecordInput): Promise<GetRecordResult> {
    const { key, portal } = this.resolveReadable(input.portalKey)
    this.screen(portal.blockedProperties, input.properties)
    const ctx: PortalContext = { token: this.d.resolveToken(key), apiHost: portal.apiHost }
    const raw = await this.d.client.getObject(
      ctx,
      input.objectType,
      input.objectId,
      input.properties,
    )
    this.d.idIndex.record(key, raw.id) // index-population invariant (on the id, pre-screen)
    // Strip any blocked field HubSpot returned by default (R4.2 — screen() only
    // covers REQUESTED names; defaults are returned when `properties` is omitted).
    const record = this.screenReturned(portal.blockedProperties, raw)
    return { portalKey: key, label: portal.label, record }
  }

  async searchRecords(input: SearchRecordsInput): Promise<SearchRecordsResult> {
    const { key, portal } = this.resolveReadable(input.portalKey)
    // Screen BOTH returned properties AND filtered-on property names — a search
    // must not even filter by a blocked/sensitive field (P1.2).
    const filterProps = (input.filters ?? []).map((f) => f.propertyName)
    this.screen(portal.blockedProperties, [...(input.properties ?? []), ...filterProps])
    const ctx: PortalContext = { token: this.d.resolveToken(key), apiHost: portal.apiHost }
    const body: SearchBody = {
      filterGroups:
        input.filters && input.filters.length > 0 ? [{ filters: input.filters }] : undefined,
      properties: input.properties,
      limit: input.limit,
    }
    const result = await this.d.client.searchObjects(ctx, input.objectType, body)
    this.d.idIndex.recordMany(
      key,
      result.results.map((r) => r.id),
    ) // index-population invariant (ids, pre-screen)
    // Strip any blocked field HubSpot returned by default from each record (R4.2).
    const records = result.results.map((r) => this.screenReturned(portal.blockedProperties, r))
    return { portalKey: key, label: portal.label, total: result.total, records }
  }

  /**
   * Recent activity across the standard engagement types: each type is searched
   * sorted by last-modified (descending), the results merged and re-sorted, and the
   * most recent `limit` returned. A type whose search fails (e.g. not enabled in the
   * portal) is dropped into `unavailableTypes` rather than failing the whole call.
   */
  async recentActivity(input: RecentActivityInput): Promise<RecentActivityResult> {
    const { key, portal } = this.resolveReadable(input.portalKey)
    const objectTypes = input.objectTypes ?? [...DEFAULT_ACTIVITY_TYPES]
    if (objectTypes.length > MAX_ACTIVITY_TYPES) {
      throw new ReadError(
        `too many object types requested (${objectTypes.length}); cap is ${MAX_ACTIVITY_TYPES}`,
      )
    }
    const ctx: PortalContext = { token: this.d.resolveToken(key), apiHost: portal.apiHost }
    const limit = input.limit ?? 10
    // Always fetch the sort property so the cross-type merge can order correctly.
    const properties = [...new Set([...(input.properties ?? []), ACTIVITY_SORT_PROPERTY])]
    // Screen the EFFECTIVE property set (the auto-added sort property included), so a
    // blocklist can't be bypassed by a field we add after the request is formed.
    this.screen(portal.blockedProperties, properties)

    // Bounded fan-out (L1): cap simultaneous searches — this is a per-type SEARCH
    // fan-out, so it is on the search budget too (#47). Each task catches its own
    // failure (so mapBounded's fail-fast never trips) and reports WHY it failed,
    // distinguishing a missing type from an auth/rate error (L4).
    const perType = await mapBounded(objectTypes, SEARCH_FANOUT_CONCURRENCY, async (objectType) => {
      try {
        const r = await this.d.client.searchObjects(ctx, objectType, {
          properties,
          sorts: [{ propertyName: ACTIVITY_SORT_PROPERTY, direction: 'DESCENDING' }],
          limit,
        })
        return { objectType, ok: true as const, results: r.results }
      } catch (e) {
        return { objectType, ok: false as const, reason: classifyReadFailure(e) }
      }
    })

    const activities: RecentActivityItem[] = []
    const unavailableTypes: UnavailableActivityType[] = []
    for (const outcome of perType) {
      if (outcome.ok) {
        for (const record of outcome.results)
          activities.push({ objectType: outcome.objectType, record })
      } else {
        unavailableTypes.push({ objectType: outcome.objectType, reason: outcome.reason })
      }
    }

    // Sort newest-first with a numeric-aware compare (as robust as the test fake, L2).
    activities.sort((a, b) =>
      compareValues(
        b.record.properties[ACTIVITY_SORT_PROPERTY],
        a.record.properties[ACTIVITY_SORT_PROPERTY],
      ),
    )
    // Sort used the full property set; strip blocked fields from what's RETURNED (R4.2).
    const top = activities.slice(0, limit).map((a) => ({
      objectType: a.objectType,
      record: this.screenReturned(portal.blockedProperties, a.record),
    }))
    this.d.idIndex.recordMany(
      key,
      top.map((a) => a.record.id),
    ) // index-population invariant
    return { portalKey: key, label: portal.label, activities: top, unavailableTypes }
  }

  /**
   * Summarize a deal or ticket pipeline: for the chosen pipeline (default the
   * portal's first for the object type), count the records in each stage via a
   * per-stage search (the `total` of an EQ filter on the type's pipeline + stage
   * properties — see PIPELINE_OBJECT_TYPES). Returns counts only — no record
   * properties — so there is no sensitive-field exposure. The pipelines path is
   * preflight-gated (see HttpHubSpotClient).
   */
  async summarizePipeline(input: SummarizePipelineInput): Promise<SummarizePipelineResult> {
    const { key, portal } = this.resolveReadable(input.portalKey)
    const objectType = input.objectType ?? 'deals'
    const { pipelineProperty, stageProperty } = PIPELINE_OBJECT_TYPES[objectType]
    const ctx: PortalContext = { token: this.d.resolveToken(key), apiHost: portal.apiHost }
    const pipelines = await this.d.client.getPipelines(ctx, objectType)
    if (pipelines.length === 0) {
      throw new ReadError(`no ${objectType} pipelines found in portal "${key}"`)
    }
    const pipeline = input.pipelineId
      ? pipelines.find((p) => p.id === input.pipelineId)
      : pipelines[0]
    if (!pipeline) {
      throw new ReadError(
        `${objectType} pipeline "${input.pipelineId}" not found in portal "${key}"`,
      )
    }

    const orderedStages = [...pipeline.stages].sort((a, b) => a.displayOrder - b.displayOrder)
    // Bounded fan-out (L1): a many-stage pipeline must not fire one search per stage
    // all at once — a default deal pipeline has 7 stages (#47). Order is preserved
    // by mapBounded.
    const stages = await mapBounded(
      orderedStages,
      SEARCH_FANOUT_CONCURRENCY,
      async (stage): Promise<PipelineStageSummary> => {
        const r = await this.d.client.searchObjects(ctx, objectType, {
          filterGroups: [
            {
              filters: [
                { propertyName: pipelineProperty, operator: 'EQ', value: pipeline.id },
                { propertyName: stageProperty, operator: 'EQ', value: stage.id },
              ],
            },
          ],
          limit: 1,
        })
        if (r.results[0]) this.d.idIndex.record(key, r.results[0].id) // index-population invariant
        return { stageId: stage.id, label: stage.label, count: r.total }
      },
    )

    return {
      portalKey: key,
      label: portal.label,
      objectType,
      pipeline: { id: pipeline.id, label: pipeline.label },
      stages,
      totalCount: stages.reduce((n, s) => n + s.count, 0),
    }
  }
}
