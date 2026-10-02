import { describe, it, expect } from 'vitest'
import { FakeConfigProvider, loadConfig, type WriteMode } from '../config/index.js'
import { PortalRegistry } from '../portals/index.js'
import { FakeHubSpotClient } from '../hubspot/fake.js'
import { PortalIdIndex } from '../safety/index.js'
import { FileAuditLog, InMemoryAuditLog, type AuditQuery } from '../audit/index.js'
import { FakeFolder } from '../store/fake.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PlanService } from '../plans/index.js'
import { ReadService } from '../reads/index.js'
import { createHandlers, type McpHandlerDeps } from './handlers.js'
import { createMcpServer } from './server.js'

function build(writeMode: WriteMode = 'apply') {
  const config = loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: {
          tokenEnv: 'A',
          expectedHubId: 111,
          label: 'Portal A',
          allowWrite: true,
          allowedObjects: ['notes', 'deals', 'contacts'],
          allowedOperations: ['create', 'update'],
          applyAllowedObjects: ['notes', 'deals', 'contacts'],
        },
        PORTAL_B: { tokenEnv: 'B', expectedHubId: 222, label: 'Portal B', allowWrite: true },
      },
      writeMode,
    }),
  )
  const registry = new PortalRegistry(config)
  const client = new FakeHubSpotClient()
  const idIndex = new PortalIdIndex()
  const audit = new InMemoryAuditLog()
  const plans = new PlanService({
    registry,
    client,
    idIndex,
    audit,
    resolveToken: (k) => `tok-${k}`,
    writeMode,
  })
  const reads = new ReadService({ registry, client, idIndex, resolveToken: (k) => `tok-${k}` })
  const deps: McpHandlerDeps = {
    registry,
    plans,
    reads,
    auditForPortal: (k) => audit.forPortal(k),
    auditAll: () => audit.all(),
  }
  return { registry, plans, reads, audit, client, idIndex, deps }
}

describe('mcp handlers', () => {
  it('list_portals returns non-secret summaries + selected default, no token material', () => {
    const out = createHandlers(build().deps).listPortals()
    expect(out.portals.map((p) => p.key)).toEqual(['PORTAL_A', 'PORTAL_B'])
    expect(out.selected).toBeNull()
    expect(JSON.stringify(out).toLowerCase()).not.toContain('token')
  })

  it('drives draft -> validate -> execute via handlers (apply mode)', async () => {
    const h = createHandlers(build('apply').deps)
    const plan = h.draftPlan('PORTAL_A', {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'hi' },
    })
    h.validatePlan(plan.id)
    const done = await h.executePlan(plan.id)
    expect(done.status).toBe('executed')
    expect(h.getPlanLog({ portalKey: 'PORTAL_A' }).events.map((e) => e.type)).toEqual([
      'draft',
      'validate',
      'attempt',
      'execute',
    ])
  })

  it('RT-08: get_audit_log defaults to the selected portal; errors when none selected; allPortals for all', async () => {
    const b = build('apply')
    const h = createHandlers(b.deps)
    const plan = h.draftPlan('PORTAL_A', {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'x' },
    })
    h.validatePlan(plan.id)
    await h.executePlan(plan.id)

    // no portal + none selected → error (never a silent all-portals fall-through)
    expect(() => h.getPlanLog()).toThrow(/no portal given and none selected/)

    // no portal + a selected default → that portal's events (mirrors the read tools)
    b.registry.setSelected('PORTAL_A')
    expect(h.getPlanLog().events.length).toBeGreaterThan(0)
    expect(h.getPlanLog().events).toEqual(h.getPlanLog({ portalKey: 'PORTAL_A' }).events)

    // explicit allPortals returns everything; portal + allPortals is refused
    expect(h.getPlanLog({ allPortals: true }).events.length).toBeGreaterThan(0)
    expect(() => h.getPlanLog({ portalKey: 'PORTAL_A', allPortals: true })).toThrow(/not both/)
  })

  it('draft_plan refuses an unknown portal', () => {
    const h = createHandlers(build().deps)
    expect(() =>
      h.draftPlan('NOPE', { kind: 'create', objectType: 'notes', properties: {} }),
    ).toThrow()
  })

  it('set_default_read_portal rejects an unknown portal', () => {
    const h = createHandlers(build().deps)
    expect(() => h.setPortal('NOPE')).toThrow()
  })

  it('get_record reads via the explicit portal and records the id for the safety index', async () => {
    const b = build()
    const h = createHandlers(b.deps)
    // seed an object under PORTAL_A's token in the fake client
    const seeded = await b.client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'contacts',
      { email: 'a@example.com' },
    )
    const out = await h.getRecord({
      portalKey: 'PORTAL_A',
      objectType: 'contacts',
      objectId: seeded.id,
    })
    expect(out.portalKey).toBe('PORTAL_A')
    expect(out.record.properties.email).toBe('a@example.com')
    // the read fed the contamination index: that id is now owned by PORTAL_A
    expect(b.idIndex.isKnownFor('PORTAL_A', seeded.id)).toBe(true)
  })

  it('get_record falls back to the selected default portal when none is given', async () => {
    const b = build()
    const h = createHandlers(b.deps)
    h.setPortal('PORTAL_B')
    const seeded = await b.client.createObject(
      { token: 'tok-PORTAL_B', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'X' },
    )
    const out = await h.getRecord({ objectType: 'deals', objectId: seeded.id })
    expect(out.portalKey).toBe('PORTAL_B')
  })
})

describe('recent_activity + summarize_pipeline handlers', () => {
  it('recent_activity returns merged activity newest-first via the explicit portal', async () => {
    const b = build()
    const h = createHandlers(b.deps)
    await b.client.createObject({ token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' }, 'notes', {
      hs_lastmodifieddate: '2026-06-01',
    })
    await b.client.createObject({ token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' }, 'calls', {
      hs_lastmodifieddate: '2026-06-05',
    })
    const out = await h.recentActivity({ portalKey: 'PORTAL_A', limit: 5 })
    expect(out.portalKey).toBe('PORTAL_A')
    expect(out.activities[0]?.objectType).toBe('calls') // most recent first
  })

  it('summarize_pipeline returns per-stage counts via the explicit portal', async () => {
    const b = build()
    const h = createHandlers(b.deps)
    b.client.seedPipelines('tok-PORTAL_A', 'deals', [
      { id: 'p', label: 'Sales', stages: [{ id: 's1', label: 'New', displayOrder: 0 }] },
    ])
    await b.client.createObject({ token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' }, 'deals', {
      pipeline: 'p',
      dealstage: 's1',
    })
    const out = await h.summarizePipeline({ portalKey: 'PORTAL_A' })
    expect(out.stages).toEqual([{ stageId: 's1', label: 'New', count: 1 }])
    expect(out.totalCount).toBe(1)
  })
})

describe('show_plan echoes the approval phrase', () => {
  it('returns the exact approve_plan phrase as approvalPhrase', () => {
    const h = createHandlers(build('apply').deps)
    const plan = h.draftPlan('PORTAL_A', {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'x' },
    })
    expect(h.showPlan(plan.id).approvalPhrase).toBe(`approve plan ${plan.id} for PORTAL_A`)
  })
})

describe('createMcpServer (SDK wiring smoke test)', () => {
  it('registers every tool the docs promise, and no surprises', async () => {
    // `expect(server).toBeDefined()` stayed green even if registration were removed
    // entirely (review 2026-09-27). Ask the server what it exposes instead.
    const { registry, plans, reads, audit } = build()
    const server = createMcpServer({ registry, plans, reads, audit })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'add_note',
        'approve_plan',
        'create_task',
        'draft_plan',
        'execute_plan',
        'get_audit_log',
        'get_record',
        'list_portals',
        'log_call',
        'log_meeting',
        'inspect_plan_target',
        'recent_activity',
        'search_records',
        'set_default_read_portal',
        'show_plan',
        'summarize_pipeline',
        'update_deal_stage',
        'validate_plan',
      ].sort(),
    )
    await client.close()
  })
})

/** Handlers reading ONE audit log; the other deps are irrelevant to these tests. */
function handlersOver(log: AuditQuery) {
  return createHandlers({
    ...build().deps,
    auditForPortal: (k) => log.forPortal(k),
    auditAll: () => log.all(),
  })
}

/**
 * The shape an auditor really sees (#49): four writers, each numbering its OWN trail,
 * interleaved across two portals. w3 spends its seq 4 and 5 on PORTAL_B, so PORTAL_A's
 * view of w3 jumps 3 -> 6 while PORTAL_B's view of it starts at 4. Nothing is missing:
 * this is the reported trail (1..9, 1..6, 1..7, 1..41, 46..52) in miniature.
 */
function interleavedTrail(): FileAuditLog {
  const folder = new FakeFolder()
  const line = (writer: string, seq: number, portalKey: string, at: number): void =>
    folder.add(writer, { type: 'draft', planId: `${writer}-${seq}`, portalKey, at, seq, writer })
  line('w1', 1, 'PORTAL_A', 1)
  line('w1', 2, 'PORTAL_A', 2)
  line('w1', 3, 'PORTAL_A', 3)
  line('w2', 1, 'PORTAL_A', 4)
  line('w2', 2, 'PORTAL_A', 5)
  line('w3', 1, 'PORTAL_A', 6)
  line('w3', 2, 'PORTAL_A', 7)
  line('w3', 3, 'PORTAL_A', 8)
  line('w3', 4, 'PORTAL_B', 9)
  line('w3', 5, 'PORTAL_B', 10)
  line('w3', 6, 'PORTAL_A', 11)
  line('w3', 7, 'PORTAL_A', 12)
  line('w4', 1, 'PORTAL_A', 13)
  line('w4', 2, 'PORTAL_A', 14)
  return new FileAuditLog(folder.storeFor('w-reader'))
}

describe('get_audit_log surfaces the writer that numbered each event (#49)', () => {
  it('guarantees `writer` on every returned event, even from a log that stores none', () => {
    const audit = new InMemoryAuditLog() // a single trail: its records carry no writer id
    audit.record({ type: 'draft', planId: 'p1', portalKey: 'PORTAL_A', at: 1 })
    const events = handlersOver(audit).getPlanLog({ portalKey: 'PORTAL_A' }).events
    expect(events).toHaveLength(1)
    expect(Object.hasOwn(events[0]!, 'writer')).toBe(true)
    // Honest, not invented: the stored event genuinely has no writer, so the
    // unattributed trail is NAMED rather than given a fabricated writer id.
    expect(audit.forPortal('PORTAL_A')[0]?.writer).toBeUndefined()
    expect(events[0]!.writer).toBe('legacy')
  })

  it('attributes a legacy line to the legacy trail, never to the copy that read it', () => {
    const folder = new FakeFolder()
    // A line from before per-writer files: no `writer` field at all.
    folder.add('legacy-file', { type: 'draft', planId: 'old', portalKey: 'PORTAL_A', at: 1 })
    const log = new FileAuditLog(folder.storeFor('w-reader'))
    log.record({ type: 'validate', planId: 'new', portalKey: 'PORTAL_A', at: 2 })
    const events = handlersOver(log).getPlanLog({ portalKey: 'PORTAL_A' }).events
    expect(events.map((e) => [e.planId, e.writer])).toEqual([
      ['old', 'legacy'],
      ['new', 'w-reader'],
    ])
  })

  it('a portal-scoped view restarts and skips across writers — the documented shape, not loss', () => {
    const h = handlersOver(interleavedTrail())
    const pa = h.getPlanLog({ portalKey: 'PORTAL_A' })
    const seqs = pa.events.map((e) => e.seq)

    // Exactly the reported shape: three restarts, and a 3 -> 6 jump.
    expect(seqs).toEqual([1, 2, 3, 1, 2, 1, 2, 3, 6, 7, 1, 2])
    expect(pa.events.map((e) => e.writer)).toEqual([
      'w1',
      'w1',
      'w1',
      'w2',
      'w2',
      'w3',
      'w3',
      'w3',
      'w3',
      'w3',
      'w4',
      'w4',
    ])
    // Non-monotonic BY DESIGN — asserted, not merely tolerated.
    expect(seqs).not.toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)))

    // `writer` + `seq` is the identity; `seq` alone is not even unique in this view.
    const pairs = pa.events.map((e) => `${e.writer}#${e.seq}`)
    expect(new Set(pairs).size).toBe(pairs.length)
    expect(new Set(seqs).size).toBeLessThan(seqs.length)

    // Each writer's own numbering still ascends: the merge preserved its trail order.
    for (const w of ['w1', 'w2', 'w3', 'w4']) {
      const own = pa.events.filter((e) => e.writer === w).map((e) => e.seq ?? 0)
      expect([...own].sort((a, b) => a - b)).toEqual(own)
    }

    // The view itself is provably whole: `n` runs 1..count with no gap of its own.
    expect(pa.events.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(pa.count).toBe(12)

    // And the "missing" 4 and 5 are not missing — they are w3's PORTAL_B events.
    const pb = h.getPlanLog({ portalKey: 'PORTAL_B' })
    expect(pb.events.map((e) => [e.writer, e.seq])).toEqual([
      ['w3', 4],
      ['w3', 5],
    ])
    expect(pb.events.map((e) => e.n)).toEqual([1, 2])
  })

  it('ships the per-writer explanation to a real client over the protocol', async () => {
    const { registry, plans, reads, audit } = build()
    const server = createMcpServer({ registry, plans, reads, audit })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'description-test', version: '0' })
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const { tools } = await client.listTools()
      // What a model actually receives before it interprets the numbers.
      const description = tools.find((t) => t.name === 'get_audit_log')?.description ?? ''
      expect(description).toMatch(/per-writer-process/)
      expect(description).toMatch(/NOT per-portal/)
      expect(description).toMatch(/RESTARTS/)
      expect(description).toMatch(/do NOT mean events are missing/)
      expect(description).toMatch(/only meaningful paired with `writer`/)
    } finally {
      await client.close()
    }
  })
})
