import { describe, it, expect } from 'vitest'
import { FakeHubSpotClient } from './fake.js'
import { HubSpotError, type PortalContext } from './index.js'

const ctxA: PortalContext = { token: 'tok-A', apiHost: 'api.hubapi.com' }
const ctxB: PortalContext = { token: 'tok-B', apiHost: 'api.hubapi.com' }

describe('FakeHubSpotClient — object lifecycle', () => {
  it('creates, reads, and updates an object', async () => {
    const c = new FakeHubSpotClient()
    const created = await c.createObject(ctxA, 'notes', { hs_note_body: 'hello' })
    expect(created.id).toBeTruthy()

    const fetched = await c.getObject(ctxA, 'notes', created.id)
    expect(fetched.properties.hs_note_body).toBe('hello')

    const updated = await c.updateObject(ctxA, 'notes', created.id, { hs_note_body: 'edited' })
    expect(updated.properties.hs_note_body).toBe('edited')
  })

  it('getObject throws HubSpotError(404) for an unknown id', async () => {
    const c = new FakeHubSpotClient()
    await expect(c.getObject(ctxA, 'notes', 'nope')).rejects.toBeInstanceOf(HubSpotError)
  })

  it.each(['TYPO', 'CONTAINS_TOKEN', 'eq '])(
    'searchObjects refuses the unsupported operator %p instead of matching everything',
    async (operator) => {
      // The guard that makes the fake no more permissive than production had no
      // negative test, so it could not be told apart from one that returns nothing
      // (#85). An unsupported operator used to match EVERY object, which reports a
      // successful, overly broad search where HubSpot would reject the request.
      const c = new FakeHubSpotClient()
      await c.createObject(ctxA, 'notes', { hs_note_body: 'n' })
      await expect(
        c.searchObjects(ctxA, 'notes', {
          filterGroups: [{ filters: [{ propertyName: 'hs_note_body', operator, value: 'n' }] }],
        }),
      ).rejects.toThrow(/unsupported search operator/)
    },
  )

  it.each(['EQ', 'eq', 'NEQ'])('still accepts the supported operator %p', async (operator) => {
    const c = new FakeHubSpotClient()
    await c.createObject(ctxA, 'notes', { hs_note_body: 'n' })
    const out = await c.searchObjects(ctxA, 'notes', {
      filterGroups: [{ filters: [{ propertyName: 'hs_note_body', operator, value: 'n' }] }],
    })
    expect(out.total).toBe(operator.toUpperCase() === 'NEQ' ? 0 : 1)
  })

  it('searchObjects returns only matching object types', async () => {
    const c = new FakeHubSpotClient()
    await c.createObject(ctxA, 'notes', { hs_note_body: 'n' })
    await c.createObject(ctxA, 'tasks', { hs_task_subject: 't' })
    const notes = await c.searchObjects(ctxA, 'notes', {})
    expect(notes.total).toBe(1)
    expect(notes.results[0]?.properties.hs_note_body).toBe('n')
  })
})

describe('FakeHubSpotClient — per-portal isolation (no cross-portal leakage)', () => {
  it('objects created under one token are invisible under another', async () => {
    const c = new FakeHubSpotClient()
    const a = await c.createObject(ctxA, 'notes', { hs_note_body: 'A only' })

    // Same id, different portal (token) → not found.
    await expect(c.getObject(ctxB, 'notes', a.id)).rejects.toBeInstanceOf(HubSpotError)
    expect(c.objectsFor('tok-B')).toHaveLength(0)
    expect(c.objectsFor('tok-A')).toHaveLength(1)
  })
})

describe('FakeHubSpotClient — account info (boot-assertion substrate)', () => {
  it('returns the seeded portalId', async () => {
    const c = new FakeHubSpotClient()
    c.setAccountInfo('tok-A', 342)
    expect((await c.getAccountInfo(ctxA)).portalId).toBe(342)
  })

  it('throws (auth failure) when account info is not seeded', async () => {
    const c = new FakeHubSpotClient()
    await expect(c.getAccountInfo(ctxA)).rejects.toBeInstanceOf(HubSpotError)
  })
})

describe('HubSpotError — sanitized error contract', () => {
  it('carries only safe fields (message, status, requestId) and no raw body', () => {
    const e = new HubSpotError('object notes/1 not found', 404, 'req-abc123')
    expect(e.message).toBe('object notes/1 not found')
    expect(e.status).toBe(404)
    expect(e.requestId).toBe('req-abc123')
    // there is deliberately no field that could carry a raw request/response body
    expect(Object.keys(e)).not.toContain('body')
    expect(Object.keys(e)).not.toContain('response')
  })
})

describe('FakeHubSpotClient — call log records the token used per call', () => {
  it('records associations and tags each call with its portal token', async () => {
    const c = new FakeHubSpotClient()
    await c.createDefaultAssociation(ctxA, 'notes', '1', 'contacts', '99')
    expect(c.associationsFor('tok-A')).toEqual([
      { fromType: 'notes', fromId: '1', toType: 'contacts', toId: '99' },
    ])
    expect(c.calls.at(-1)?.token).toBe('tok-A')
  })
})

describe('the fake validates an operator whether or not it has records (#113 8d)', () => {
  it('rejects an unsupported operator on an EMPTY portal', async () => {
    // The throw used to live inside the `results.filter(...)` callback, so with no
    // records the callback never ran and a typo resolved with zero results. A
    // new-portal test is precisely where an empty portal appears, so the check was
    // missing in the case most likely to need it.
    const fake = new FakeHubSpotClient()
    await expect(
      fake.searchObjects({ ...ctxA, token: 'tok-empty' }, 'contacts', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'TYPO', value: 'x' }] }],
      }),
    ).rejects.toThrow(/unsupported search operator/)
  })

  it('still rejects it on a portal that HAS records', async () => {
    const fake = new FakeHubSpotClient()
    await fake.createObject({ ...ctxA, token: 'tok-full' }, 'contacts', { email: 'a@example.com' })
    await expect(
      fake.searchObjects({ ...ctxA, token: 'tok-full' }, 'contacts', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'TYPO', value: 'x' }] }],
      }),
    ).rejects.toThrow(/unsupported search operator/)
  })

  it('still accepts the operators it does support', async () => {
    const fake = new FakeHubSpotClient()
    await expect(
      fake.searchObjects({ ...ctxA, token: 'tok-empty' }, 'contacts', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'x' }] }],
      }),
    ).resolves.toBeDefined()
  })
})
