import { describe, it, expect } from 'vitest'
import { FakeConfigProvider, loadConfig } from '../config/index.js'
import { PortalRegistry } from '../portals/index.js'
import { FakeHubSpotClient } from '../hubspot/fake.js'
import {
  HubSpotError,
  type PortalContext,
  type SearchBody,
  type SearchResult,
} from '../hubspot/index.js'
import { PortalIdIndex, findContamination } from '../safety/index.js'
import { ReadService, ReadError } from './index.js'

function setup(opts?: {
  blockedPropsA?: string[]
  allowReadA?: boolean
  client?: FakeHubSpotClient
}) {
  const config = loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: {
          tokenEnv: 'A',
          expectedHubId: 111,
          label: 'Portal A',
          // A parked portal is not writable: allowRead=false with allowWrite=true is
          // refused at load, because writes preflight-read their target and so a
          // write-only portal is not actually parked (#87).
          allowWrite: opts?.allowReadA ?? true,
          allowRead: opts?.allowReadA ?? true,
          blockedProperties: opts?.blockedPropsA ?? [],
        },
        PORTAL_B: { tokenEnv: 'B', expectedHubId: 222, label: 'Portal B', allowWrite: true },
      },
      writeMode: 'propose',
    }),
  )
  const registry = new PortalRegistry(config)
  const client = opts?.client ?? new FakeHubSpotClient()
  const idIndex = new PortalIdIndex()
  const reads = new ReadService({ registry, client, idIndex, resolveToken: (k) => `tok-${k}` })
  const ctx = (k: string): PortalContext => ({ token: `tok-${k}`, apiHost: 'api.hubapi.com' })
  return { registry, client, idIndex, reads, ctx }
}

describe('ReadService — portal resolution', () => {
  it('uses an explicit portal and echoes which portal was read', async () => {
    const { reads, client, ctx } = setup()
    const seeded = await client.createObject(ctx('PORTAL_A'), 'contacts', {
      email: 'a@example.com',
    })
    const out = await reads.getRecord({
      portalKey: 'PORTAL_A',
      objectType: 'contacts',
      objectId: seeded.id,
    })
    expect(out.portalKey).toBe('PORTAL_A')
    expect(out.label).toBe('Portal A')
    expect(out.record.properties.email).toBe('a@example.com')
  })

  it('falls back to the selected default portal when none is given (reads may default)', async () => {
    const { reads, registry, client, ctx } = setup()
    registry.setSelected('PORTAL_B')
    const seeded = await client.createObject(ctx('PORTAL_B'), 'deals', { dealname: 'X' })
    const out = await reads.getRecord({ objectType: 'deals', objectId: seeded.id })
    expect(out.portalKey).toBe('PORTAL_B')
  })

  it('refuses when no portal is given and no default is selected', async () => {
    const { reads } = setup()
    await expect(reads.getRecord({ objectType: 'contacts', objectId: '1' })).rejects.toThrow()
  })

  it('routes the read to the resolved portal token (no cross-portal leakage)', async () => {
    const { reads, client, ctx } = setup()
    await client.createObject(ctx('PORTAL_A'), 'contacts', { email: 'only-a@example.com' })
    // searching PORTAL_B must not see PORTAL_A's records
    const res = await reads.searchRecords({ portalKey: 'PORTAL_B', objectType: 'contacts' })
    expect(res.total).toBe(0)
  })
})

describe('ReadService — feeds the contamination index (red-team P2)', () => {
  it('records a read record id under its portal, so a later cross-portal write is caught', async () => {
    const { reads, idIndex, client, ctx } = setup()
    const seeded = await client.createObject(ctx('PORTAL_A'), 'contacts', {
      email: 'a@example.com',
    })
    await reads.getRecord({ portalKey: 'PORTAL_A', objectType: 'contacts', objectId: seeded.id })
    expect(idIndex.isKnownFor('PORTAL_A', seeded.id)).toBe(true)
    // referencing that id in a write to PORTAL_B is now contamination
    expect(findContamination(idIndex, 'PORTAL_B', [seeded.id])).toHaveLength(1)
  })

  it('records every id returned by a search', async () => {
    const { reads, idIndex, client, ctx } = setup()
    await client.createObject(ctx('PORTAL_A'), 'deals', { dealname: '1' })
    await client.createObject(ctx('PORTAL_A'), 'deals', { dealname: '2' })
    const res = await reads.searchRecords({ portalKey: 'PORTAL_A', objectType: 'deals' })
    for (const r of res.records) expect(idIndex.isKnownFor('PORTAL_A', r.id)).toBe(true)
  })
})

describe('ReadService — sensitive-property screen (brief §6b)', () => {
  it('refuses to read an explicitly requested blocked property (names the field, not a value)', async () => {
    const { reads } = setup({ blockedPropsA: ['hs_*sensitive*'] })
    await expect(
      reads.getRecord({
        portalKey: 'PORTAL_A',
        objectType: 'contacts',
        objectId: '1',
        properties: ['email', 'hs_super_sensitive_ssn'],
      }),
    ).rejects.toBeInstanceOf(ReadError)
  })

  it('refuses a SEARCH that filters by a blocked property (filter-by-sensitive, P1.2)', async () => {
    const { reads } = setup({ blockedPropsA: ['hs_*sensitive*'] })
    await expect(
      reads.searchRecords({
        portalKey: 'PORTAL_A',
        objectType: 'contacts',
        filters: [{ propertyName: 'hs_super_sensitive_ssn', operator: 'EQ', value: '123' }],
      }),
    ).rejects.toBeInstanceOf(ReadError)
  })

  it('allows reads that request only non-blocked properties', async () => {
    const { reads, client, ctx } = setup({ blockedPropsA: ['hs_*sensitive*'] })
    const seeded = await client.createObject(ctx('PORTAL_A'), 'contacts', {
      email: 'a@example.com',
    })
    const out = await reads.getRecord({
      portalKey: 'PORTAL_A',
      objectType: 'contacts',
      objectId: seeded.id,
      properties: ['email'],
    })
    expect(out.record.id).toBe(seeded.id)
  })
})

describe('ReadService — allowRead gate', () => {
  it('refuses every read tool against a parked portal (allowRead=false)', async () => {
    const { reads, client, ctx } = setup({ allowReadA: false })
    await client.createObject(ctx('PORTAL_A'), 'contacts', { email: 'a@example.com' })
    await expect(
      reads.getRecord({ portalKey: 'PORTAL_A', objectType: 'contacts', objectId: '1' }),
    ).rejects.toBeInstanceOf(ReadError)
    await expect(
      reads.searchRecords({ portalKey: 'PORTAL_A', objectType: 'contacts' }),
    ).rejects.toBeInstanceOf(ReadError)
    await expect(reads.recentActivity({ portalKey: 'PORTAL_A' })).rejects.toBeInstanceOf(ReadError)
    await expect(reads.summarizePipeline({ portalKey: 'PORTAL_A' })).rejects.toBeInstanceOf(
      ReadError,
    )
  })

  it('still allows reads against a portal with allowRead defaulted true', async () => {
    const { reads, client, ctx } = setup()
    const seeded = await client.createObject(ctx('PORTAL_A'), 'contacts', {
      email: 'x@example.com',
    })
    const out = await reads.getRecord({
      portalKey: 'PORTAL_A',
      objectType: 'contacts',
      objectId: seeded.id,
    })
    expect(out.portalKey).toBe('PORTAL_A')
  })
})

describe('ReadService — recent_activity', () => {
  it('merges activity types newest-first, tags each, and records ids', async () => {
    const { reads, idIndex, client, ctx } = setup()
    const note = await client.createObject(ctx('PORTAL_A'), 'notes', {
      hs_lastmodifieddate: '2026-06-01T00:00:00Z',
    })
    const call = await client.createObject(ctx('PORTAL_A'), 'calls', {
      hs_lastmodifieddate: '2026-06-03T00:00:00Z',
    })
    const task = await client.createObject(ctx('PORTAL_A'), 'tasks', {
      hs_lastmodifieddate: '2026-06-02T00:00:00Z',
    })
    const out = await reads.recentActivity({ portalKey: 'PORTAL_A', limit: 10 })
    expect(out.activities.map((a) => a.record.id)).toEqual([call.id, task.id, note.id])
    expect(out.activities.map((a) => a.objectType)).toEqual(['calls', 'tasks', 'notes'])
    expect(out.unavailableTypes).toEqual([])
    expect(idIndex.isKnownFor('PORTAL_A', call.id)).toBe(true)
  })

  it('honors the limit across the merged set', async () => {
    const { reads, client, ctx } = setup()
    await client.createObject(ctx('PORTAL_A'), 'notes', { hs_lastmodifieddate: '2026-06-01' })
    await client.createObject(ctx('PORTAL_A'), 'calls', { hs_lastmodifieddate: '2026-06-02' })
    await client.createObject(ctx('PORTAL_A'), 'tasks', { hs_lastmodifieddate: '2026-06-03' })
    const out = await reads.recentActivity({ portalKey: 'PORTAL_A', limit: 2 })
    expect(out.activities).toHaveLength(2)
  })

  it('sorts numerically so epoch-millis timestamps order correctly (not lexically)', async () => {
    const { reads, client, ctx } = setup()
    // '9' < '10' numerically but '10' < '9' lexically — proves the numeric compare.
    const older = await client.createObject(ctx('PORTAL_A'), 'notes', { hs_lastmodifieddate: '9' })
    const newer = await client.createObject(ctx('PORTAL_A'), 'calls', {
      hs_lastmodifieddate: '10',
    })
    const out = await reads.recentActivity({ portalKey: 'PORTAL_A' })
    expect(out.activities.map((a) => a.record.id)).toEqual([newer.id, older.id])
  })

  it('classifies a failed type by reason instead of mislabeling it absent (R3.C)', async () => {
    const { reads, client, ctx } = setup()
    await client.createObject(ctx('PORTAL_A'), 'notes', { hs_lastmodifieddate: '5' })
    client.failSearchFor('tok-PORTAL_A', 'emails', new HubSpotError('rate', 429))
    client.failSearchFor('tok-PORTAL_A', 'calls', new HubSpotError('forbidden', 403))
    const out = await reads.recentActivity({ portalKey: 'PORTAL_A' })
    expect(out.activities.map((a) => a.objectType)).toEqual(['notes'])
    expect(out.unavailableTypes).toContainEqual({ objectType: 'emails', reason: 'rate-limited' })
    expect(out.unavailableTypes).toContainEqual({ objectType: 'calls', reason: 'auth/permission' })
  })

  it('rejects an objectTypes list over the cap', async () => {
    const { reads } = setup()
    const many = Array.from({ length: 21 }, (_, i) => `type_${i}`)
    await expect(
      reads.recentActivity({ portalKey: 'PORTAL_A', objectTypes: many }),
    ).rejects.toBeInstanceOf(ReadError)
  })
})

describe('ReadService — summarize_pipeline', () => {
  it('counts deals per stage in display order and totals them', async () => {
    const { reads, client, ctx } = setup()
    client.seedPipelines('tok-PORTAL_A', 'deals', [
      {
        id: 'default',
        label: 'Sales Pipeline',
        stages: [
          { id: 'new', label: 'New', displayOrder: 0 },
          { id: 'won', label: 'Won', displayOrder: 1 },
        ],
      },
    ])
    // two deals in 'new', one in 'won'
    await client.createObject(ctx('PORTAL_A'), 'deals', { pipeline: 'default', dealstage: 'new' })
    await client.createObject(ctx('PORTAL_A'), 'deals', { pipeline: 'default', dealstage: 'new' })
    await client.createObject(ctx('PORTAL_A'), 'deals', { pipeline: 'default', dealstage: 'won' })
    const out = await reads.summarizePipeline({ portalKey: 'PORTAL_A' })
    expect(out.objectType).toBe('deals') // default object type
    expect(out.pipeline.label).toBe('Sales Pipeline')
    expect(out.stages).toEqual([
      { stageId: 'new', label: 'New', count: 2 },
      { stageId: 'won', label: 'Won', count: 1 },
    ])
    expect(out.totalCount).toBe(3)
  })

  it('records one sampled record id per non-empty stage without returning it', async () => {
    // THE CLAIM BEHIND A PUBLISHED SENTENCE (#226). SAFETY.md said "an ID it has never
    // returned is not judged at all", which this tool falsifies: it records a sampled
    // record id per non-empty stage and returns none of them, so an id the assistant was
    // never shown IS judged by the cross-portal check later. The sentence was an
    // over-correction made while fixing the opposite error, and it is now bound here.
    const { reads, client, ctx, idIndex } = setup()
    client.seedPipelines('tok-PORTAL_A', 'deals', [
      {
        id: 'default',
        label: 'Sales Pipeline',
        stages: [
          { id: 'new', label: 'New', displayOrder: 0 },
          { id: 'won', label: 'Won', displayOrder: 1 },
          { id: 'lost', label: 'Lost', displayOrder: 2 },
        ],
      },
    ])
    const inNew = await client.createObject(ctx('PORTAL_A'), 'deals', {
      pipeline: 'default',
      dealstage: 'new',
    })
    const inWon = await client.createObject(ctx('PORTAL_A'), 'deals', {
      pipeline: 'default',
      dealstage: 'won',
    })
    // 'lost' is left empty on purpose: with no record to sample, nothing is recorded.

    const out = await reads.summarizePipeline({ portalKey: 'PORTAL_A' })

    // HALF ONE — the ids ARE recorded, which is what makes them judgeable later.
    expect(idIndex.isKnownFor('PORTAL_A', inNew.id)).toBe(true)
    expect(idIndex.isKnownFor('PORTAL_A', inWon.id)).toBe(true)
    // Non-vacuity: isKnownFor does not simply answer true.
    expect(idIndex.isKnownFor('PORTAL_A', '123456789')).toBe(false)

    // HALF TWO — and none of them reached the caller. Asserted STRUCTURALLY rather than
    // by searching the result for the id: the fake numbers records from 1, and "1" is
    // also a stage count here, so a substring search would pass by luck on a result that
    // did leak an id. `toEqual` is exact on keys, so an added field fails this.
    expect(out.stages).toEqual([
      { stageId: 'new', label: 'New', count: 1 },
      { stageId: 'won', label: 'Won', count: 1 },
      { stageId: 'lost', label: 'Lost', count: 0 },
    ])
  })

  it('throws when the portal has no deal pipelines', async () => {
    const { reads } = setup()
    await expect(reads.summarizePipeline({ portalKey: 'PORTAL_A' })).rejects.toBeInstanceOf(
      ReadError,
    )
  })

  it('summarizes a TICKET pipeline via hs_pipeline/hs_pipeline_stage', async () => {
    const { reads, client, ctx } = setup()
    client.seedPipelines('tok-PORTAL_A', 'tickets', [
      {
        id: 'support',
        label: 'Support',
        stages: [
          { id: 'triage', label: 'Triage', displayOrder: 0 },
          { id: 'closed', label: 'Closed', displayOrder: 1 },
        ],
      },
    ])
    await client.createObject(ctx('PORTAL_A'), 'tickets', {
      hs_pipeline: 'support',
      hs_pipeline_stage: 'triage',
    })
    await client.createObject(ctx('PORTAL_A'), 'tickets', {
      hs_pipeline: 'support',
      hs_pipeline_stage: 'closed',
    })
    const out = await reads.summarizePipeline({ portalKey: 'PORTAL_A', objectType: 'tickets' })
    expect(out.objectType).toBe('tickets')
    expect(out.stages).toEqual([
      { stageId: 'triage', label: 'Triage', count: 1 },
      { stageId: 'closed', label: 'Closed', count: 1 },
    ])
    expect(out.totalCount).toBe(2)
  })
})

describe('ReadService — blocked properties are stripped from RESULTS, not just requests (R4.2)', () => {
  it('get_record strips a blocked field HubSpot returned by default (no `properties` requested)', async () => {
    const { reads, client, ctx } = setup({ blockedPropsA: ['*secret*', 'email'] })
    const seeded = await client.createObject(ctx('PORTAL_A'), 'contacts', {
      firstname: 'Ada',
      email: 'ada@example.com',
      api_secret: 'sk-must-not-surface',
    })
    const out = await reads.getRecord({
      portalKey: 'PORTAL_A',
      objectType: 'contacts',
      objectId: seeded.id,
    })
    expect(out.record.properties.firstname).toBe('Ada') // non-blocked kept
    expect(out.record.properties.email).toBeUndefined() // exact-name block stripped from result
    expect(out.record.properties.api_secret).toBeUndefined() // *secret* pattern stripped from result
  })

  it('search_records strips blocked fields from every returned record', async () => {
    const { reads, client, ctx } = setup({ blockedPropsA: ['*secret*'] })
    await client.createObject(ctx('PORTAL_A'), 'contacts', { firstname: 'Ada', api_secret: 'x' })
    const out = await reads.searchRecords({ portalKey: 'PORTAL_A', objectType: 'contacts' })
    expect(out.records.length).toBeGreaterThan(0)
    for (const r of out.records) expect(r.properties.api_secret).toBeUndefined()
  })
})

/**
 * Records the HIGH-WATER MARK of searches in flight at once. The fake yields before
 * answering, so overlapping calls are genuinely observed together rather than each
 * completing before the next begins.
 */
class ConcurrencyRecordingClient extends FakeHubSpotClient {
  private inFlight = 0
  maxInFlight = 0

  override async searchObjects(
    ctx: PortalContext,
    objectType: string,
    body: SearchBody,
  ): Promise<SearchResult> {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return await super.searchObjects(ctx, objectType, body)
    } finally {
      this.inFlight -= 1
    }
  }
}

describe('ReadService — search fan-out stays inside the HubSpot search budget (#47)', () => {
  it('caps simultaneous per-stage searches for a default 7-stage deal pipeline', async () => {
    const client = new ConcurrencyRecordingClient()
    const { reads } = setup({ client })
    // A default HubSpot deal pipeline has 7 stages — the shape that 429'd every time
    // under the old cap of 6, while a 4-stage ticket pipeline stayed under it.
    client.seedPipelines('tok-PORTAL_A', 'deals', [
      {
        id: 'default',
        label: 'Sales Pipeline',
        stages: Array.from({ length: 7 }, (_, i) => ({
          id: `stage_${i}`,
          label: `Stage ${i}`,
          displayOrder: i,
        })),
      },
    ])

    const out = await reads.summarizePipeline({ portalKey: 'PORTAL_A' })

    expect(client.maxInFlight).toBeLessThanOrEqual(3) // never bursts past the search cap
    expect(out.stages).toHaveLength(7) // …and every stage is still counted
    expect(client.maxInFlight).toBeGreaterThan(1) // …without serializing the fan-out
  })

  it('caps the per-type activity search fan-out on the same budget', async () => {
    const client = new ConcurrencyRecordingClient()
    const { reads } = setup({ client })
    const objectTypes = [
      'notes',
      'calls',
      'emails',
      'meetings',
      'tasks',
      'communications',
      'postal_mail',
    ]

    await reads.recentActivity({ portalKey: 'PORTAL_A', objectTypes })

    expect(client.maxInFlight).toBeLessThanOrEqual(3)
    expect(client.calls.filter((c) => c.method === 'searchObjects')).toHaveLength(7)
    expect(client.maxInFlight).toBeGreaterThan(1)
  })
})
