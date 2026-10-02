import { SafeError } from '../errors/index.js'

/**
 * Resolved per-portal context for a single API call. The token is passed in per
 * call (AR-1), never stored on the client, and must never be logged or returned.
 */
export interface PortalContext {
  token: string
  apiHost: string
}

export interface HubSpotObject {
  id: string
  properties: Record<string, string>
}

export interface SearchBody {
  filterGroups?: unknown[]
  properties?: string[]
  limit?: number
  after?: string
  /** Sort directives (HubSpot CRM search): direction is 'ASCENDING' | 'DESCENDING'. */
  sorts?: Array<{ propertyName: string; direction: string }>
}

export interface SearchResult {
  total: number
  results: HubSpotObject[]
}

export interface AccountInfo {
  /** HubSpot hub/portal id — checked against the configured expectedHubId at boot. */
  portalId: number
}

export interface PipelineStage {
  id: string
  label: string
  displayOrder: number
}

/** A CRM pipeline (e.g. a deal pipeline) and its ordered stages. */
export interface Pipeline {
  id: string
  label: string
  stages: PipelineStage[]
}

/**
 * The HubSpot API boundary (AR-1 / AR-2). Implemented by `FakeHubSpotClient`
 * (tests) and, later, `HttpHubSpotClient` (real REST). The write methods here
 * are called ONLY by the plan executor — they are never registered directly as
 * MCP tools.
 */
export interface HubSpotClient {
  getAccountInfo(ctx: PortalContext): Promise<AccountInfo>
  getObject(
    ctx: PortalContext,
    objectType: string,
    id: string,
    properties?: string[],
  ): Promise<HubSpotObject>
  searchObjects(ctx: PortalContext, objectType: string, body: SearchBody): Promise<SearchResult>
  /** Read all pipelines (with stages) for an object type (e.g. 'deals'). Read-only. */
  getPipelines(ctx: PortalContext, objectType: string): Promise<Pipeline[]>
  /** Read the property NAMES defined for an object type (blocked-pattern coverage). Read-only. */
  getProperties(ctx: PortalContext, objectType: string): Promise<string[]>
  createObject(
    ctx: PortalContext,
    objectType: string,
    properties: Record<string, string>,
  ): Promise<HubSpotObject>
  updateObject(
    ctx: PortalContext,
    objectType: string,
    id: string,
    properties: Record<string, string>,
  ): Promise<HubSpotObject>
  createDefaultAssociation(
    ctx: PortalContext,
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
  ): Promise<void>
}

/**
 * The sanitized error contract for the HubSpot boundary (red-team P1).
 *
 * Every field here is SAFE to surface to the MCP client and the audit log: a
 * pre-sanitized `message`, the HTTP `status`, and an optional HubSpot
 * `requestId` (correlation id) for support. The real `HttpHubSpotClient` MUST
 * construct these and MUST NEVER place tokens, request/response bodies, raw
 * headers, or echoed property values into any field. There is deliberately no
 * field for a raw body — sanitization happens where the error is built, so
 * callers can surface a `HubSpotError` without re-checking it for secrets.
 *
 * `retryAfterMs` is the ONE header-derived value callers may act on: HubSpot
 * returns `Retry-After` on a 429 in MILLISECONDS (not the usual seconds). It is
 * stored as a parsed non-negative integer, never raw header text, so it stays
 * inside the sanitized contract above.
 */
export class HubSpotError extends SafeError {
  constructor(
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'HubSpotError'
  }
}
