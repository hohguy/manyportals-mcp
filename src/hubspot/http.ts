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

/** Injectable fetch (the Node global by default) so the client is unit-testable without a network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Injectable delay, used ONLY for the 429 backoff below, so tests can exercise
 * the retry path without really waiting.
 */
export type SleepLike = (ms: number) => Promise<void>

const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * HubSpot date-based API version (2026-03 release). Centralized here so the next
 * version hop is a one-line change. Date-versioned APIs are immutable snapshots
 * of the latest v3/v4 surface with a fixed support window — HubSpot's recommended
 * choice for new integrations, and we are raw REST (not the official SDK, whose
 * Node date-version support lagged), so adopting it has no SDK dependency.
 */
export const HUBSPOT_API_VERSION = '2026-03'

/**
 * Validate + encode ONE path segment (RT-07). `encodeURIComponent` does NOT encode
 * `.`, so a raw objectType/id of `..` would survive into the path and WHATWG URL
 * normalization would collapse it to a DIFFERENT endpoint. Reject the
 * path-structural characters (`/`, `.`, `%`, whitespace) and empty up front, then
 * STILL percent-encode so anything else (`?`, `#`, `&`, …) cannot inject into the
 * query/fragment. Valid HubSpot object types / record ids use only letters,
 * digits, `-`, `_` (e.g. `2-12345`, `p12345_car`; ids are numeric). The error
 * names no segment value (it could be a caller-controlled token — see HIGH-1).
 * NOTE: an email-as-id (`idProperty`) feature would need the `.` rule revisited.
 */
function pathSegment(value: string): string {
  if (value === '' || /[/.%\s]/.test(value)) {
    throw new HubSpotError('invalid HubSpot path segment')
  }
  return encodeURIComponent(value)
}

/** CRM objects base path for an object type under the date-based version. */
function objectsPath(objectType: string): string {
  return `/crm/objects/${HUBSPOT_API_VERSION}/${pathSegment(objectType)}`
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  path: string
  query?: Record<string, string | undefined>
  body?: unknown
  /**
   * Opt-in: this exact request may be SAFELY re-sent after a 429. Defaults to
   * false, and only genuine reads may set it — re-sending a create would
   * duplicate a record, which the whole mediated-write promise forbids.
   *
   * The HTTP method is NOT a usable discriminator here: HubSpot's search is a
   * POST and is idempotent, while object-create is also a POST and is not. So
   * the decision is made once, per call site, by the method that knows.
   */
  idempotent?: boolean
}

/** Map a HubSpot pipeline payload to our minimal shape, validating required fields (P1.7). */
function toPipeline(data: unknown): Pipeline {
  const d = data as { id?: unknown; label?: unknown; stages?: unknown } | null
  if (d === null || (typeof d.id !== 'string' && typeof d.id !== 'number')) {
    throw new HubSpotError('unexpected HubSpot response: pipeline id missing or malformed')
  }
  const rawStages = Array.isArray(d.stages) ? d.stages : []
  const stages = rawStages.map((s) => {
    const st = s as { id?: unknown; label?: unknown; displayOrder?: unknown }
    if (typeof st.id !== 'string' && typeof st.id !== 'number') {
      throw new HubSpotError('unexpected HubSpot response: pipeline stage id missing or malformed')
    }
    return {
      id: String(st.id),
      label: typeof st.label === 'string' ? st.label : String(st.id),
      displayOrder: typeof st.displayOrder === 'number' ? st.displayOrder : 0,
    }
  })
  return {
    id: String(d.id),
    label: typeof d.label === 'string' ? d.label : String(d.id),
    stages,
  }
}

/** Map a HubSpot CRM object payload to our minimal shape, validating required fields (P1.7). */
function toObject(data: unknown): HubSpotObject {
  const d = data as { id?: unknown; properties?: unknown } | null
  if (d === null || (typeof d.id !== 'string' && typeof d.id !== 'number')) {
    throw new HubSpotError('unexpected HubSpot response: object id missing or malformed')
  }
  const properties =
    d.properties !== null && typeof d.properties === 'object'
      ? (d.properties as Record<string, string>)
      : {}
  return { id: String(d.id), properties }
}

/**
 * Real REST implementation of the HubSpot boundary (AR-1).
 *
 * Call shapes are harvested from shinzo-labs/hubspot-mcp (MIT) and adapted to
 * (a) take a resolved per-portal token + apiHost PER CALL (never a stored
 * closure token), (b) THROW a sanitized `HubSpotError` instead of shinzo's
 * string returns, and (c) target the 2026-03 date-based API version for CRM
 * object CRUD (HubSpot's documented swap: /crm/v3/objects/{t} -> /crm/objects/
 * 2026-03/{t}). This layer makes no safety decisions — routing, contamination,
 * and approval all live in the plan/safety layers. It is written here but is NOT
 * exercised live until the operator-run preflight (no live calls in this phase).
 *
 * Mixed-version by design (raw REST, so mixing is fine — the no-straddle caveat
 * is SDK-only): CRM object CRUD is on 2026-03; associations use the verified v4
 * default endpoint and account details the verified /account-info/v3/details.
 * The 2026-03 reference DOES list a date-versioned "Associate records (default)"
 * endpoint and account-details endpoint, but their literal date-versioned paths
 * are not in the provided index — so those two stay on their verified paths
 * (v4 supported through 2027-03) and migrate at preflight.
 *
 * Sanitization: errors carry only method + path + status (+ correlation id when
 * present). Response bodies are NEVER read into an error, and the per-call token
 * appears only in the Authorization header — never in a URL, message, or log.
 */
/**
 * Default timeout for ONE ATTEMPT — a stalled HubSpot response must not wedge the
 * single-threaded server.
 *
 * Per attempt, not per call: since #48 an idempotent read may be re-sent after a
 * 429, so a rate-limited read can span up to MAX_RATE_LIMIT_RETRIES + 1 attempts
 * plus the waits between them (~100s worst case at the constants below, against
 * ~30s before). Still bounded and still fail-closed — but a caller budgeting on
 * this number alone would be budgeting for one attempt.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Max re-sends of an IDEMPOTENT request after a 429 (so at most 3 attempts total). */
const MAX_RATE_LIMIT_RETRIES = 2
/** Wait used when a 429 carries no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 1_000
/** Upper clamp on an honoured `Retry-After` — an absurd value must not wedge the server. */
const MAX_RETRY_AFTER_MS = 5_000

/**
 * Read ONE allowlisted numeric response header.
 *
 * Parsed to a non-negative integer and dropped unless the whole value is digits,
 * so nothing derived from a header can carry attacker- or body-controlled TEXT
 * into an error message. This is the only reason it is safe to put these values
 * in a `HubSpotError` at all (P1.7 / P2.3: the BODY is still never read).
 */
function numericHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name)?.trim()
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

/** The allowlisted HubSpot rate-limit headers, all parsed to integers. */
interface RateLimitInfo {
  /** HubSpot returns `Retry-After` in MILLISECONDS on a 429 (not seconds — verified). */
  retryAfterMs: number | undefined
  secondlyLimit: number | undefined
  secondlyRemaining: number | undefined
  /** Daily headers are API-key auth only — absent on OAuth/private-app tokens. */
  dailyLimit: number | undefined
  dailyRemaining: number | undefined
}

function readRateLimit(response: Response): RateLimitInfo {
  return {
    retryAfterMs: numericHeader(response, 'retry-after'),
    secondlyLimit: numericHeader(response, 'x-hubspot-ratelimit-secondly'),
    secondlyRemaining: numericHeader(response, 'x-hubspot-ratelimit-secondly-remaining'),
    dailyLimit: numericHeader(response, 'x-hubspot-ratelimit-daily'),
    dailyRemaining: numericHeader(response, 'x-hubspot-ratelimit-daily-remaining'),
  }
}

/**
 * Render the rate-limit headers as a short suffix for the sanitized message, so a
 * 429 arrives as actionable diagnostics instead of a bare `status 429` (#48 — the
 * absence of exactly this is why a deterministic burst read as an environmental
 * rate limit for two days). Integers only; empty when no header was present.
 */
function formatRateLimit(info: RateLimitInfo): string {
  const parts: string[] = []
  if (info.retryAfterMs !== undefined) parts.push(`retry after ${info.retryAfterMs}ms`)
  if (info.secondlyLimit !== undefined || info.secondlyRemaining !== undefined) {
    parts.push(
      `secondly limit ${info.secondlyLimit ?? 'unknown'}, remaining ${info.secondlyRemaining ?? 'unknown'}`,
    )
  }
  if (info.dailyLimit !== undefined || info.dailyRemaining !== undefined) {
    parts.push(
      `daily limit ${info.dailyLimit ?? 'unknown'}, remaining ${info.dailyRemaining ?? 'unknown'}`,
    )
  }
  return parts.length > 0 ? ` (${parts.join('; ')})` : ''
}

/**
 * How long to wait before re-sending a failed attempt, or `undefined` for "do not
 * retry — rethrow". The safety gate lives here, in one place:
 *
 *  - `idempotent !== true` NEVER retries. A 429 on a create/update/association
 *    fails loud exactly as before, so the write-ahead `attempt` audit marker and
 *    the plan lifecycle keep their current meaning, and no write can be doubled.
 *  - only a 429 retries (not a 5xx, not a timeout — those may have applied).
 *  - bounded attempts, and the honoured delay is clamped so a hostile or absurd
 *    `Retry-After` cannot park the single-threaded server.
 */
function retryDelayFor(e: unknown, spec: RequestSpec, attempt: number): number | undefined {
  if (spec.idempotent !== true) return undefined
  if (attempt >= MAX_RATE_LIMIT_RETRIES) return undefined
  if (!(e instanceof HubSpotError) || e.status !== 429) return undefined
  return Math.min(e.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS)
}

export class HttpHubSpotClient implements HubSpotClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    private readonly sleepImpl: SleepLike = defaultSleep,
  ) {}

  /**
   * Send `spec`, re-sending it after a 429 ONLY when the call site opted in via
   * `idempotent` (see `retryDelayFor` for the full gate). The per-attempt timeout
   * and sanitization are unchanged — each attempt is a full `requestOnce`.
   */
  private async request(ctx: PortalContext, spec: RequestSpec): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(ctx, spec)
      } catch (e) {
        const waitMs = retryDelayFor(e, spec, attempt)
        // Not retryable (a write, a non-429, or attempts exhausted): surface the
        // sanitized error WITH its diagnostics, unchanged.
        if (waitMs === undefined) throw e
        await this.sleepImpl(waitMs)
      }
    }
  }

  /** ONE attempt: build the URL, send it under the timeout, sanitize any failure. */
  private async requestOnce(ctx: PortalContext, spec: RequestSpec): Promise<unknown> {
    const query = new URLSearchParams()
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      if (v !== undefined) query.set(k, v)
    }
    const qs = query.toString()
    // apiHost is constrained to the egress allowlist by config validation (AR-5).
    const url = `https://${ctx.apiHost}${spec.path}${qs ? `?${qs}` : ''}`

    const headers: Record<string, string> = { Authorization: `Bearer ${ctx.token}` }
    const init: RequestInit = { method: spec.method, headers }
    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(spec.body)
    }

    // Abort a request that stalls past the timeout so one slow HubSpot response
    // can't hang the event loop indefinitely (the runtime peer of boot's withTimeout).
    // The signal stays live through the BODY read too, so a stalled response stream
    // is aborted as well — the timer is cleared only once the whole request resolves.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      let response: Response
      try {
        // redirect:'error' — the sole runtime egress is api.hubapi.com (AR-5); a 3xx
        // from HubSpot must NOT be followed to another origin. A redirect rejects the
        // fetch → the sanitized catch below, never a second request off-allowlist.
        response = await this.fetchImpl(url, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        })
      } catch {
        // Abort (timeout) and network errors are indistinguishable to callers by
        // design — never surface the caught error verbatim; sanitized message only.
        throw new HubSpotError(
          `request to HubSpot failed or timed out (${spec.method} ${spec.path})`,
        )
      }

      if (!response.ok) {
        // Read a correlation id and the allowlisted NUMERIC rate-limit headers;
        // deliberately do NOT read the body (it can echo tokens, submitted property
        // values, or other customer data). Header values are integer-parsed by
        // `numericHeader`, so no raw header text reaches the message either.
        const requestId = response.headers.get('x-request-id') ?? undefined
        const rateLimit = readRateLimit(response)
        throw new HubSpotError(
          `HubSpot API error (${spec.method} ${spec.path}): status ${response.status}` +
            formatRateLimit(rateLimit),
          response.status,
          requestId,
          rateLimit.retryAfterMs,
        )
      }

      if (response.status === 204) return undefined
      try {
        return await response.json()
      } catch {
        // Malformed/non-JSON body — sanitized error, never the raw body (P1.7 / P2.3).
        throw new HubSpotError(
          `unexpected non-JSON response (${spec.method} ${spec.path})`,
          response.status,
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async getAccountInfo(ctx: PortalContext): Promise<AccountInfo> {
    // GET /account-info/v3/details returns a numeric `portalId` (verified, HubSpot
    // Account Information API). Account details also appear in the 2026-03 reference,
    // but the literal date-versioned path isn't in the provided index — stay on the
    // verified v3 path until the date-versioned path is confirmed at preflight.
    const data = (await this.request(ctx, {
      method: 'GET',
      path: '/account-info/v3/details',
      idempotent: true, // read-only
    })) as { portalId?: unknown }
    if (typeof data.portalId !== 'number') {
      throw new HubSpotError('unexpected account-info response: portalId missing or malformed')
    }
    return { portalId: data.portalId }
  }

  async getObject(
    ctx: PortalContext,
    objectType: string,
    id: string,
    properties?: string[],
  ): Promise<HubSpotObject> {
    const data = await this.request(ctx, {
      method: 'GET',
      path: `${objectsPath(objectType)}/${pathSegment(id)}`,
      query: properties && properties.length > 0 ? { properties: properties.join(',') } : undefined,
      idempotent: true, // read-only
    })
    return toObject(data)
  }

  async searchObjects(
    ctx: PortalContext,
    objectType: string,
    body: SearchBody,
  ): Promise<SearchResult> {
    const data = (await this.request(ctx, {
      method: 'POST',
      path: `${objectsPath(objectType)}/search`,
      body,
      // A POST, but a read: search creates nothing, so re-sending it after a 429 is
      // safe. This is the call that gets rate-limited first — search has a much
      // tighter burst budget than the general APIs (4/sec on Free/Starter).
      idempotent: true,
    })) as { total?: unknown; results?: unknown }
    const rawResults = Array.isArray(data.results) ? data.results : []
    const results = rawResults.map(toObject)
    return { total: typeof data.total === 'number' ? data.total : results.length, results }
  }

  async getPipelines(ctx: PortalContext, objectType: string): Promise<Pipeline[]> {
    // GET /crm/v3/pipelines/{objectType} → { results: [{ id, label, stages: [...] }] }.
    // The 2026-03 reference lists Pipelines under CRM, but the literal date-versioned
    // path isn't in the provided index; v3 pipelines is the stable surface — stay on
    // v3 and migrate the path at the operator preflight (same posture as account-info
    // and associations). NEEDS_VERIFICATION at preflight. Read-only.
    const data = (await this.request(ctx, {
      method: 'GET',
      path: `/crm/v3/pipelines/${pathSegment(objectType)}`,
      idempotent: true, // read-only
    })) as { results?: unknown }
    const raw = Array.isArray(data.results) ? data.results : []
    return raw.map(toPipeline)
  }

  async getProperties(ctx: PortalContext, objectType: string): Promise<string[]> {
    // GET /crm/v3/properties/{objectType} → { results: [{ name, ... }] }. Read-only.
    // Used by the operator preflight to flag blockedProperties patterns that match no
    // real property (a dead pattern silently blocks nothing). Same v3-until-preflight
    // posture as pipelines — the 2026-03 reference lists Properties but the literal
    // date-versioned path isn't in the provided index. NEEDS_VERIFICATION at preflight.
    const data = (await this.request(ctx, {
      method: 'GET',
      path: `/crm/v3/properties/${pathSegment(objectType)}`,
      idempotent: true, // read-only
    })) as { results?: unknown }
    const raw = Array.isArray(data.results) ? data.results : []
    return raw
      .map((p) => (p as { name?: unknown }).name)
      .filter((n): n is string => typeof n === 'string')
  }

  async createObject(
    ctx: PortalContext,
    objectType: string,
    properties: Record<string, string>,
  ): Promise<HubSpotObject> {
    const data = await this.request(ctx, {
      method: 'POST',
      path: objectsPath(objectType),
      body: { properties },
    })
    return toObject(data)
  }

  async updateObject(
    ctx: PortalContext,
    objectType: string,
    id: string,
    properties: Record<string, string>,
  ): Promise<HubSpotObject> {
    const data = await this.request(ctx, {
      method: 'PATCH',
      path: `${objectsPath(objectType)}/${pathSegment(id)}`,
      body: { properties },
    })
    return toObject(data)
  }

  async createDefaultAssociation(
    ctx: PortalContext,
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
  ): Promise<void> {
    // The v4 DEFAULT-association endpoint creates an unlabeled association with
    // no associationTypeId and no request body (verified, HubSpot Associations
    // v4 "Create default"). Chosen deliberately to avoid hardcoding HubSpot type
    // ids (shinzo uses the typed endpoint). The 2026-03 reference lists a
    // date-versioned "Associate records (default)" endpoint, but its literal path
    // isn't in the provided index; v4 is supported through 2027-03, so stay on v4
    // and migrate the path at preflight.
    await this.request(ctx, {
      method: 'PUT',
      path:
        `/crm/v4/objects/${pathSegment(fromType)}/${pathSegment(fromId)}` +
        `/associations/default/${pathSegment(toType)}/${pathSegment(toId)}`,
    })
  }
}
