import { describe, it, expect } from 'vitest'
import { HttpHubSpotClient, type FetchLike } from './http.js'
import { HubSpotError, type PortalContext } from './types.js'

const ctx: PortalContext = { token: 'pat-na1-SECRET', apiHost: 'api.hubapi.com' }

/** A recording fetch: captures (url, init) and returns whatever `responder` produces. No network. */
function mockFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return responder(url, init)
  }
  return { fn, calls }
}

const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const headerOf = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name]

describe('HttpHubSpotClient — request construction (verified shinzo shapes)', () => {
  it('createObject: POST /crm/objects/2026-03/{type} with a Bearer token and JSON body', async () => {
    const { fn, calls } = mockFetch(() => json({ id: 501, properties: { hs_note_body: 'hi' } }))
    const obj = await new HttpHubSpotClient(fn).createObject(ctx, 'notes', { hs_note_body: 'hi' })

    expect(calls[0]?.url).toBe('https://api.hubapi.com/crm/objects/2026-03/notes')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(headerOf(calls[0]?.init, 'Authorization')).toBe('Bearer pat-na1-SECRET')
    expect(headerOf(calls[0]?.init, 'Content-Type')).toBe('application/json')
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ properties: { hs_note_body: 'hi' } }))
    expect(obj).toEqual({ id: '501', properties: { hs_note_body: 'hi' } })
  })

  it('getObject: GET with a properties query, id coerced to string', async () => {
    const { fn, calls } = mockFetch(() => json({ id: '7', properties: { email: 'x@example.com' } }))
    await new HttpHubSpotClient(fn).getObject(ctx, 'contacts', '7', ['email', 'firstname'])
    expect(calls[0]?.url).toBe(
      'https://api.hubapi.com/crm/objects/2026-03/contacts/7?properties=email%2Cfirstname',
    )
    expect(calls[0]?.init?.method).toBe('GET')
  })

  it('updateObject: PATCH /crm/objects/2026-03/{type}/{id}', async () => {
    const { fn, calls } = mockFetch(() => json({ id: '9', properties: { dealstage: 'won' } }))
    await new HttpHubSpotClient(fn).updateObject(ctx, 'deals', '9', { dealstage: 'won' })
    expect(calls[0]?.url).toBe('https://api.hubapi.com/crm/objects/2026-03/deals/9')
    expect(calls[0]?.init?.method).toBe('PATCH')
  })

  it('searchObjects: POST .../search, mapping total + results', async () => {
    const { fn, calls } = mockFetch(() =>
      json({
        total: 2,
        results: [
          { id: 1, properties: {} },
          { id: 2, properties: {} },
        ],
      }),
    )
    const res = await new HttpHubSpotClient(fn).searchObjects(ctx, 'companies', { limit: 10 })
    expect(calls[0]?.url).toBe('https://api.hubapi.com/crm/objects/2026-03/companies/search')
    expect(res.total).toBe(2)
    expect(res.results.map((r) => r.id)).toEqual(['1', '2'])
  })

  it('createDefaultAssociation: PUT v4 default-association endpoint, no body, 204 ok', async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 204 }))
    await new HttpHubSpotClient(fn).createDefaultAssociation(ctx, 'notes', '1', 'contacts', '99')
    expect(calls[0]?.url).toBe(
      'https://api.hubapi.com/crm/v4/objects/notes/1/associations/default/contacts/99',
    )
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(headerOf(calls[0]?.init, 'Content-Type')).toBeUndefined()
  })

  it('getAccountInfo: GET /account-info/v3/details → portalId', async () => {
    const { fn, calls } = mockFetch(() => json({ portalId: 343 }))
    const info = await new HttpHubSpotClient(fn).getAccountInfo(ctx)
    expect(calls[0]?.url).toBe('https://api.hubapi.com/account-info/v3/details')
    expect(info.portalId).toBe(343)
  })

  /**
   * SAFETY.md "Token values stay out of results.", the sentence (#206): "They are sent only
   * as the authorization header of a HubSpot request."
   *
   * Registered in scripts/claims-register.json. "Only" is the word under test, and it
   * quantifies over every request this client makes, so this enumerates all eight methods
   * rather than sampling one: the tests above each pin one method's URL and verb, and the
   * sentence is about a property of the whole surface.
   *
   * Three places a token could travel are checked per request — the URL, the body, and any
   * header that is not `Authorization` — and the Authorization header is asserted to carry
   * it. That last assertion is the non-vacuity control: a request whose token went
   * somewhere else entirely, or a fixture that never passed one, would otherwise leave the
   * three "not present" checks passing over nothing.
   */
  it('the token goes only into the Authorization header, on every request this client makes', async () => {
    // Not credential-SHAPED on purpose. With a PAT-shaped value a redactor somewhere in
    // the chain could remove it and this test would pass by proving the redactor works,
    // rather than that the value is only ever put in one place.
    const token = 'portal-token-value-under-test'
    const here: PortalContext = { token, apiHost: 'api.hubapi.com' }
    const { fn, calls } = mockFetch(
      () =>
        json({
          id: '1',
          properties: {},
          portalId: 7,
          total: 0,
          results: [],
          inputs: [],
        }),
      // one responder for all of them; each method's own shape is pinned above
    )
    const c = new HttpHubSpotClient(fn)
    await c.getAccountInfo(here)
    await c.getObject(here, 'contacts', '1')
    await c.searchObjects(here, 'contacts', { limit: 1 })
    await c.getPipelines(here, 'deals')
    await c.getProperties(here, 'deals')
    await c.createObject(here, 'notes', { hs_note_body: 'hi' })
    await c.updateObject(here, 'deals', '1', { amount: '1' })
    await c.createDefaultAssociation(here, 'notes', '1', 'contacts', '2')

    expect(calls, 'not every client method issued a request, so this proves nothing').toHaveLength(
      8,
    )
    for (const { url, init } of calls) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers.Authorization, `${url} did not carry the token`).toBe(`Bearer ${token}`)
      expect(url, 'the token reached the URL').not.toContain(token)
      expect(String(init?.body ?? ''), 'the token reached the request body').not.toContain(token)
      expect(
        Object.entries(headers)
          .filter(([name]) => name !== 'Authorization')
          .filter(([, value]) => value.includes(token))
          .map(([name]) => name),
        'the token reached another header',
      ).toEqual([])
    }
  })
})

describe('HttpHubSpotClient — sanitized errors (no token / body leakage)', () => {
  it('throws HubSpotError(status, requestId) on a non-OK response, never echoing the body', async () => {
    const { fn } = mockFetch(
      () =>
        // a hostile error body that must NOT reach the thrown error
        new Response('{"message":"token pat-na1-SECRET rejected","value":"123-45-6789"}', {
          status: 403,
          headers: { 'x-request-id': 'req-abc' },
        }),
    )
    let caught: unknown
    try {
      await new HttpHubSpotClient(fn).createObject(ctx, 'notes', { hs_note_body: 'hi' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HubSpotError)
    const err = caught as HubSpotError
    expect(err.status).toBe(403)
    expect(err.requestId).toBe('req-abc')
    expect(err.message).not.toContain('pat-') // no token
    expect(err.message).not.toContain('123-45-6789') // no echoed body data
  })

  it('throws a sanitized HubSpotError when fetch itself rejects (no token in message)', async () => {
    const fn: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED pat-na1-SECRET')
    }
    let caught: unknown
    try {
      await new HttpHubSpotClient(fn).getAccountInfo(ctx)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HubSpotError)
    expect((caught as Error).message).not.toContain('pat-')
  })
})

describe('HttpHubSpotClient — response validation (P1.7)', () => {
  it('throws HubSpotError when a created object has no id (not a "undefined" id)', async () => {
    const { fn } = mockFetch(() => json({ noId: true, properties: {} }))
    await expect(
      new HttpHubSpotClient(fn).createObject(ctx, 'notes', { hs_note_body: 'x' }),
    ).rejects.toBeInstanceOf(HubSpotError)
  })

  it('throws a sanitized HubSpotError on a non-JSON success body', async () => {
    const { fn } = mockFetch(
      () =>
        new Response('<html>gateway error</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    await expect(new HttpHubSpotClient(fn).getObject(ctx, 'notes', '1')).rejects.toBeInstanceOf(
      HubSpotError,
    )
  })

  it('throws HubSpotError when account-info lacks a numeric portalId', async () => {
    const { fn } = mockFetch(() => json({ portalId: 'not-a-number' }))
    await expect(new HttpHubSpotClient(fn).getAccountInfo(ctx)).rejects.toBeInstanceOf(HubSpotError)
  })

  it('tolerates a non-array search results field (returns empty)', async () => {
    const { fn } = mockFetch(() => json({ total: 0, results: null }))
    const res = await new HttpHubSpotClient(fn).searchObjects(ctx, 'contacts', {})
    expect(res.results).toEqual([])
    expect(res.total).toBe(0)
  })

  it('aborts a stalled request past the timeout — sanitized error, never hangs', async () => {
    // A fetch that never resolves but rejects when the abort signal fires (as real fetch does).
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const client = new HttpHubSpotClient(hangingFetch, 20) // 20ms timeout
    await expect(client.getObject(ctx, 'contacts', '1')).rejects.toThrow(/failed or timed out/)
  })

  it('passes an abort signal on every request (runtime timeout wired)', async () => {
    const { fn, calls } = mockFetch(() => json({ id: '1', properties: {} }))
    await new HttpHubSpotClient(fn).getObject(ctx, 'contacts', '1')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('sets redirect:"error" on every request (egress must not follow a 3xx off api.hubapi.com)', async () => {
    const { fn, calls } = mockFetch(() => json({ id: '1', properties: {} }))
    await new HttpHubSpotClient(fn).getObject(ctx, 'contacts', '1')
    expect(calls[0]?.init?.redirect).toBe('error')
  })
})

describe('HttpHubSpotClient — path-segment validation (RT-07)', () => {
  it('rejects a traversal/structural object type or id BEFORE any request', async () => {
    const { fn, calls } = mockFetch(() => json({ id: '1', properties: {} }))
    const c = new HttpHubSpotClient(fn)
    await expect(c.getObject(ctx, '..', '1')).rejects.toBeInstanceOf(HubSpotError)
    await expect(c.getObject(ctx, 'contacts', '../9')).rejects.toBeInstanceOf(HubSpotError)
    await expect(c.createObject(ctx, 'a/b', {})).rejects.toBeInstanceOf(HubSpotError)
    await expect(
      c.createDefaultAssociation(ctx, 'notes', '1', '../evil', '2'),
    ).rejects.toBeInstanceOf(HubSpotError)
    expect(calls.length).toBe(0) // refused before any fetch — nothing left the process
  })

  it('accepts valid HubSpot custom-object identifiers (e.g. 2-12345)', async () => {
    const { fn } = mockFetch(() => json({ id: '5', properties: {} }))
    await expect(new HttpHubSpotClient(fn).getObject(ctx, '2-12345', '5')).resolves.toBeDefined()
  })
})

describe('HttpHubSpotClient — 429 diagnostics and opt-in retry (#47/#48)', () => {
  /** A recording sleep: captures each wait without ever really waiting (keeps the suite fast). */
  function recordingSleep() {
    const waits: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms)
    }
    return { sleep, waits }
  }

  /** A 429 whose BODY is hostile — it must never reach the thrown error. */
  const rateLimited = (headers: Record<string, string>): Response =>
    new Response('{"message":"secondly limit hit for pat-na1-SECRET","ssn":"123-45-6789"}', {
      status: 429,
      headers,
    })

  /** One body that satisfies every read mapper (object, search, pipelines, properties, account). */
  const readBody = { id: '1', properties: {}, total: 0, results: [], portalId: 343 }

  const RATE_HEADERS = {
    'retry-after': '250',
    'x-hubspot-ratelimit-secondly': '4',
    'x-hubspot-ratelimit-secondly-remaining': '0',
  }

  it('retries an idempotent search after a 429, honouring Retry-After as MILLISECONDS', async () => {
    let n = 0
    const { fn, calls } = mockFetch(() => (n++ === 0 ? rateLimited(RATE_HEADERS) : json(readBody)))
    const { sleep, waits } = recordingSleep()
    const res = await new HttpHubSpotClient(fn, 30_000, sleep).searchObjects(ctx, 'deals', {})
    expect(calls.length).toBe(2) // re-sent after the 429
    expect(waits).toEqual([250]) // 250ms — NOT 250_000; HubSpot sends milliseconds
    expect(res.total).toBe(0) // and the retry's result is what the caller gets
  })

  it('gives up after a bounded number of retries, still surfacing the diagnostics', async () => {
    const { fn, calls } = mockFetch(() => rateLimited(RATE_HEADERS))
    const { sleep, waits } = recordingSleep()
    const err = (await new HttpHubSpotClient(fn, 30_000, sleep)
      .searchObjects(ctx, 'deals', {})
      .catch((e: unknown) => e)) as HubSpotError
    expect(calls.length).toBe(3) // 1 attempt + 2 retries — bounded, not a hot loop
    expect(waits).toEqual([250, 250])
    expect(err).toBeInstanceOf(HubSpotError)
    expect(err.status).toBe(429)
    expect(err.message).toContain('retry after 250ms')
  })

  it('does NOT retry a non-idempotent write — a 429 on create/update/associate fails loud', async () => {
    const writes: Array<(c: HttpHubSpotClient) => Promise<unknown>> = [
      (c) => c.createObject(ctx, 'notes', { hs_note_body: 'x' }),
      (c) => c.updateObject(ctx, 'deals', '9', { dealstage: 'won' }),
      (c) => c.createDefaultAssociation(ctx, 'notes', '1', 'contacts', '9'),
    ]
    for (const invoke of writes) {
      const { fn, calls } = mockFetch(() => rateLimited(RATE_HEADERS))
      const { sleep, waits } = recordingSleep()
      const err = await invoke(new HttpHubSpotClient(fn, 30_000, sleep)).catch((e: unknown) => e)
      expect(calls.length).toBe(1) // sent ONCE — a retried create would duplicate a record
      expect(waits).toEqual([]) // never even waited
      expect(err).toBeInstanceOf(HubSpotError)
      expect((err as HubSpotError).status).toBe(429)
    }
  })

  it('retries every read call site (search, object, pipelines, properties, account-info)', async () => {
    const reads: Array<(c: HttpHubSpotClient) => Promise<unknown>> = [
      (c) => c.searchObjects(ctx, 'deals', {}),
      (c) => c.getObject(ctx, 'contacts', '1'),
      (c) => c.getPipelines(ctx, 'deals'),
      (c) => c.getProperties(ctx, 'deals'),
      (c) => c.getAccountInfo(ctx),
    ]
    for (const invoke of reads) {
      let n = 0
      const { fn, calls } = mockFetch(() =>
        n++ === 0 ? rateLimited(RATE_HEADERS) : json(readBody),
      )
      const { sleep } = recordingSleep()
      await expect(invoke(new HttpHubSpotClient(fn, 30_000, sleep))).resolves.toBeDefined()
      expect(calls.length).toBe(2)
    }
  })

  it('carries the limit headers in the message and retryAfterMs on the error, never the body', async () => {
    const { fn } = mockFetch(() =>
      rateLimited({
        ...RATE_HEADERS,
        'x-hubspot-ratelimit-daily': '250000',
        'x-hubspot-ratelimit-daily-remaining': '12',
        'x-request-id': 'req-429',
      }),
    )
    const { sleep } = recordingSleep()
    const err = (await new HttpHubSpotClient(fn, 30_000, sleep)
      .createObject(ctx, 'notes', { hs_note_body: 'x' })
      .catch((e: unknown) => e)) as HubSpotError
    expect(err.status).toBe(429)
    expect(err.requestId).toBe('req-429')
    expect(err.retryAfterMs).toBe(250)
    expect(err.message).toContain('status 429')
    expect(err.message).toContain('retry after 250ms')
    expect(err.message).toContain('secondly limit 4, remaining 0')
    expect(err.message).toContain('daily limit 250000, remaining 12')
    // …and the hostile body is still never read (P1.7 / P2.3)
    expect(err.message).not.toContain('pat-')
    expect(err.message).not.toContain('123-45-6789')
    expect(err.message).not.toContain('secondly limit hit')
  })

  it('clamps an absurd Retry-After instead of parking the server on it', async () => {
    const { fn } = mockFetch(() => rateLimited({ 'retry-after': '600000' })) // 10 minutes
    const { sleep, waits } = recordingSleep()
    await new HttpHubSpotClient(fn, 30_000, sleep)
      .searchObjects(ctx, 'deals', {})
      .catch(() => undefined)
    expect(waits.length).toBeGreaterThan(0)
    expect(waits.every((w) => w <= 5_000)).toBe(true)
  })

  it('ignores a non-numeric Retry-After — no raw header text in the message', async () => {
    const { fn } = mockFetch(() => rateLimited({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))
    const { sleep, waits } = recordingSleep()
    const err = (await new HttpHubSpotClient(fn, 30_000, sleep)
      .searchObjects(ctx, 'deals', {})
      .catch((e: unknown) => e)) as HubSpotError
    expect(err.retryAfterMs).toBeUndefined()
    expect(err.message).not.toContain('Wed, 21 Oct') // header text never echoed
    expect(err.message).not.toContain('retry after')
    expect(waits).toEqual([1_000, 1_000]) // falls back to the default wait, still bounded
  })

  it('does not retry a non-429 failure, even on an idempotent read', async () => {
    const { fn, calls } = mockFetch(() => new Response('{}', { status: 500 }))
    const { sleep, waits } = recordingSleep()
    await new HttpHubSpotClient(fn, 30_000, sleep)
      .searchObjects(ctx, 'deals', {})
      .catch(() => undefined)
    expect(calls.length).toBe(1)
    expect(waits).toEqual([])
  })
})
