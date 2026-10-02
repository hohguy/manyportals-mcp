import {
  HubSpotError,
  type AccountInfo,
  type HubSpotClient,
  type HubSpotObject,
  type Pipeline,
  type PortalContext,
  type SearchBody,
  type SearchResult,
} from './types.js'
import { compareValues } from '../util/index.js'

interface FakePortalState {
  portalId: number | undefined
  objects: Map<string, { type: string; obj: HubSpotObject }>
  associations: Array<{ fromType: string; fromId: string; toType: string; toId: string }>
  pipelines: Map<string, Pipeline[]>
  properties: Map<string, string[]>
  nextId: number
}

interface FakeFilter {
  propertyName: string
  operator: string
  value?: string
}

/** Minimal filter match for the fake: EQ/NEQ on a property value. */
const SUPPORTED_OPERATORS = ['EQ', 'NEQ'] as const

/**
 * A fake must not accept what production does not: an unsupported operator used to
 * match everything here, so a test could report a successful, overly broad search
 * where HubSpot would reject the request (review 2026-09-27).
 *
 * Validated SEPARATELY from matching, because the throw used to live inside the
 * `results.filter(...)` callback: on a portal with no records the callback never ran,
 * so a typo'd operator resolved with zero results instead of raising. A new-portal
 * test is exactly where an empty portal appears, so the check was absent in the one
 * case it was most likely to be needed (#113 8d).
 */
function assertOperatorSupported(f: FakeFilter): void {
  const op = f.operator.toUpperCase()
  if (!(SUPPORTED_OPERATORS as readonly string[]).includes(op)) {
    throw new Error(
      `FakeHubSpotClient: unsupported search operator "${f.operator}". Add it here, or fix the test.`,
    )
  }
}

function matchesFilter(o: HubSpotObject, f: FakeFilter): boolean {
  const actual = o.properties[f.propertyName]
  switch (f.operator.toUpperCase()) {
    case 'EQ':
      return actual === f.value
    case 'NEQ':
      return actual !== f.value
    default:
      throw new Error(
        `FakeHubSpotClient: unsupported search operator "${f.operator}". Add it here, or fix the test.`,
      )
  }
}

export interface RecordedCall {
  method: string
  token: string
  args: unknown
}

/**
 * Deterministic in-memory `HubSpotClient` for tests. State is keyed by token, so
 * distinct portals (distinct tokens) are fully isolated — this is the substrate
 * the cross-portal no-mixing tests rely on. Makes no network calls.
 */
export class FakeHubSpotClient implements HubSpotClient {
  private readonly states = new Map<string, FakePortalState>()
  /** Injected search failures, keyed `${token}::${objectType}` (test setup). */
  private readonly searchFailures = new Map<string, HubSpotError>()
  /** Injected getObject failures, same keying. */
  private readonly getFailures = new Map<string, HubSpotError>()
  private readonly propertyFailures = new Map<string, HubSpotError>()
  readonly calls: RecordedCall[] = []

  /** Seed a portal's account info. If unset, getAccountInfo throws (simulated auth failure). */
  setAccountInfo(token: string, portalId: number): void {
    this.stateFor(token).portalId = portalId
  }

  /** Make searchObjects throw for one object type (test setup for read-failure paths). */
  failSearchFor(token: string, objectType: string, error: HubSpotError): void {
    this.searchFailures.set(`${token}::${objectType}`, error)
  }

  /**
   * Make getObject throw for one object type — the peer of `failSearchFor`, which
   * existed while its getObject equivalent did not. Preflight reads target records
   * through getObject, so the non-404 rethrow path had no way to be exercised.
   */
  failGetFor(token: string, objectType: string, error: HubSpotError): void {
    this.getFailures.set(`${token}::${objectType}`, error)
  }

  /**
   * Make getProperties throw — the third peer, added because preflight's
   * blocked-property coverage check has an error path that nothing could reach. A 403
   * from a missing scope and a 429 are both ordinary answers from the real API, and
   * that path used to report the check as PASSED (#111).
   */
  failPropertiesFor(token: string, objectType: string, error: HubSpotError): void {
    this.propertyFailures.set(`${token}::${objectType}`, error)
  }

  private stateFor(token: string): FakePortalState {
    let s = this.states.get(token)
    if (s === undefined) {
      s = {
        portalId: undefined,
        objects: new Map(),
        associations: [],
        pipelines: new Map(),
        properties: new Map(),
        nextId: 1,
      }
      this.states.set(token, s)
    }
    return s
  }

  /** Seed a portal's pipelines for an object type (test setup for summarize_pipeline). */
  seedPipelines(token: string, objectType: string, pipelines: Pipeline[]): void {
    this.stateFor(token).pipelines.set(objectType, pipelines)
  }

  async getAccountInfo(ctx: PortalContext): Promise<AccountInfo> {
    this.calls.push({ method: 'getAccountInfo', token: ctx.token, args: undefined })
    const portalId = this.stateFor(ctx.token).portalId
    if (portalId === undefined) {
      throw new HubSpotError('account info unavailable for token (simulated auth failure)', 401)
    }
    return { portalId }
  }

  async getObject(ctx: PortalContext, objectType: string, id: string): Promise<HubSpotObject> {
    this.calls.push({ method: 'getObject', token: ctx.token, args: { objectType, id } })
    const failure = this.getFailures.get(`${ctx.token}::${objectType}`)
    if (failure) throw failure
    const rec = this.stateFor(ctx.token).objects.get(id)
    if (rec === undefined || rec.type !== objectType) {
      throw new HubSpotError(`object ${objectType}/${id} not found`, 404)
    }
    return rec.obj
  }

  async searchObjects(
    ctx: PortalContext,
    objectType: string,
    body: SearchBody,
  ): Promise<SearchResult> {
    this.calls.push({ method: 'searchObjects', token: ctx.token, args: { objectType } })
    const failure = this.searchFailures.get(`${ctx.token}::${objectType}`)
    if (failure) throw failure
    let results = [...this.stateFor(ctx.token).objects.values()]
      .filter((r) => r.type === objectType)
      .map((r) => r.obj)

    // Honor a minimal filter subset: filterGroups OR'd together, filters AND'd
    // within a group, operators EQ/NEQ (enough to test per-stage pipeline counts).
    const groups = (body.filterGroups ?? []) as Array<{ filters?: FakeFilter[] }>
    // Before filtering, and so regardless of whether the portal holds any records.
    for (const g of groups) for (const f of g.filters ?? []) assertOperatorSupported(f)
    if (groups.length > 0) {
      results = results.filter((o) =>
        groups.some((g) => (g.filters ?? []).every((f) => matchesFilter(o, f))),
      )
    }

    // `total` is the full match count, independent of the page size (as HubSpot does).
    const total = results.length

    const sort = body.sorts?.[0]
    if (sort) {
      const dir = sort.direction.toUpperCase().startsWith('DESC') ? -1 : 1
      results = [...results].sort(
        (a, b) =>
          compareValues(a.properties[sort.propertyName], b.properties[sort.propertyName]) * dir,
      )
    }

    if (typeof body.limit === 'number') results = results.slice(0, body.limit)
    return { total, results }
  }

  async getPipelines(ctx: PortalContext, objectType: string): Promise<Pipeline[]> {
    this.calls.push({ method: 'getPipelines', token: ctx.token, args: { objectType } })
    return this.stateFor(ctx.token).pipelines.get(objectType) ?? []
  }

  /** Seed the property NAMES defined for an object type (test setup for coverage checks). */
  seedProperties(token: string, objectType: string, names: string[]): void {
    this.stateFor(token).properties.set(objectType, names)
  }

  async getProperties(ctx: PortalContext, objectType: string): Promise<string[]> {
    this.calls.push({ method: 'getProperties', token: ctx.token, args: { objectType } })
    const failure = this.propertyFailures.get(`${ctx.token}::${objectType}`)
    if (failure) throw failure
    return this.stateFor(ctx.token).properties.get(objectType) ?? []
  }

  async createObject(
    ctx: PortalContext,
    objectType: string,
    properties: Record<string, string>,
  ): Promise<HubSpotObject> {
    this.calls.push({ method: 'createObject', token: ctx.token, args: { objectType, properties } })
    const s = this.stateFor(ctx.token)
    const id = String(s.nextId++)
    const obj: HubSpotObject = { id, properties: { ...properties } }
    s.objects.set(id, { type: objectType, obj })
    return obj
  }

  async updateObject(
    ctx: PortalContext,
    objectType: string,
    id: string,
    properties: Record<string, string>,
  ): Promise<HubSpotObject> {
    this.calls.push({
      method: 'updateObject',
      token: ctx.token,
      args: { objectType, id, properties },
    })
    const rec = this.stateFor(ctx.token).objects.get(id)
    if (rec === undefined || rec.type !== objectType) {
      throw new HubSpotError(`object ${objectType}/${id} not found`, 404)
    }
    rec.obj = { id, properties: { ...rec.obj.properties, ...properties } }
    return rec.obj
  }

  async createDefaultAssociation(
    ctx: PortalContext,
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
  ): Promise<void> {
    this.calls.push({
      method: 'createDefaultAssociation',
      token: ctx.token,
      args: { fromType, fromId, toType, toId },
    })
    this.stateFor(ctx.token).associations.push({ fromType, fromId, toType, toId })
  }

  // --- test inspection helpers ---

  objectsFor(token: string): HubSpotObject[] {
    return [...this.stateFor(token).objects.values()].map((r) => r.obj)
  }

  associationsFor(token: string): ReadonlyArray<{
    fromType: string
    fromId: string
    toType: string
    toId: string
  }> {
    return [...this.stateFor(token).associations]
  }
}
