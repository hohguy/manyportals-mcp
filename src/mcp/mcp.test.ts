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

  it('RETURNS THE MOST RECENT N EVENTS WHEN GIVEN A LIMIT, with n still absolute', async () => {
    // #146. #30 decided to DECLARE this log unbounded rather than cap it, and the
    // declaration was honest. What it could not change is that the caller reading it most
    // is a model with a context window: six full-history pulls to read six tail events
    // exhausted the assistant's context partway through QA section 6C, and the report
    // degraded from verbatim quotes to summaries at exactly the point where verbatim was
    // the thing under test.
    const b = build('apply')
    const h = createHandlers(b.deps)
    for (const body of ['one', 'two', 'three']) {
      const plan = h.draftPlan('PORTAL_A', {
        kind: 'create',
        objectType: 'notes',
        properties: { hs_note_body: body },
      })
      h.validatePlan(plan.id)
      await h.executePlan(plan.id)
    }
    const all = h.getPlanLog({ portalKey: 'PORTAL_A' })
    // Non-vacuity: there is a history long enough for a window to be a window.
    expect(all.count).toBeGreaterThan(4)

    const tail = h.getPlanLog({ portalKey: 'PORTAL_A', limit: 2 })
    expect(tail.events.length).toBe(2)
    // count stays the TOTAL, so a window is distinguishable from an exhaustive read.
    expect(tail.count).toBe(all.count)
    // and it is the MOST RECENT two, not the first two.
    expect(tail.events.map((e) => e.type)).toEqual(all.events.slice(-2).map((e) => e.type))
    // `n` is the position in the WHOLE log, which is what says where the window sits.
    expect(tail.events.map((e) => e.n)).toEqual([all.count - 1, all.count])
  })

  it('leaves an unbounded read byte-for-byte unchanged', async () => {
    // The control. The offset is zero without a limit, so adding the bound must not have
    // moved any existing caller's numbering.
    const b = build('apply')
    const h = createHandlers(b.deps)
    const plan = h.draftPlan('PORTAL_A', {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'x' },
    })
    h.validatePlan(plan.id)
    await h.executePlan(plan.id)
    const log = h.getPlanLog({ portalKey: 'PORTAL_A' })
    expect(log.events.map((e) => e.n)).toEqual(log.events.map((_, i) => i + 1))
    expect(log.count).toBe(log.events.length)
  })

  it('a limit larger than the log returns the whole log rather than refusing', async () => {
    const b = build('apply')
    const h = createHandlers(b.deps)
    const plan = h.draftPlan('PORTAL_A', {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'x' },
    })
    h.validatePlan(plan.id)
    await h.executePlan(plan.id)
    const everything = h.getPlanLog({ portalKey: 'PORTAL_A' })
    const over = h.getPlanLog({ portalKey: 'PORTAL_A', limit: everything.count + 100 })
    expect(over.events.length).toBe(everything.count)
    expect(over.events.map((e) => e.n)).toEqual(everything.events.map((e) => e.n))
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

  /**
   * The four tests below are SAFETY.md's "A cross-portal check runs before writes." (#203),
   * registered in scripts/claims-register.json, and they live here rather than in
   * plans.test.ts because each one spans both halves of the mechanism: the reads that
   * RECORD an id and the plan that is judged against what was recorded. `build()` wires one
   * id index into both services, which is the only place that pairing exists in a test.
   */
  it('records every id it returns against the portal it came from, and refuses a write reusing one', async () => {
    const b = build()
    const h = createHandlers(b.deps)
    const inB = { token: 'tok-PORTAL_B', apiHost: 'api.hubapi.com' }
    const one = await b.client.createObject(inB, 'contacts', { email: 'b1@example.com' })
    const two = await b.client.createObject(inB, 'contacts', { email: 'b2@example.com' })
    const three = await b.client.createObject(inB, 'deals', { dealname: 'B3' })
    // Seeding is not reading: nothing is attributed until a read RETURNS the record.
    for (const id of [one.id, two.id, three.id]) {
      expect(b.idIndex.isKnownFor('PORTAL_B', id), 'seeding attributed the id').toBe(false)
    }

    // "Each record it returns" covers both read shapes, so one id comes back from
    // get_record and the other two from a search.
    await h.getRecord({ portalKey: 'PORTAL_B', objectType: 'deals', objectId: three.id })
    const found = await h.searchRecords({ portalKey: 'PORTAL_B', objectType: 'contacts' })
    const returned = [three.id, ...found.records.map((r) => r.id)]
    expect(returned, 'no record was returned, so this proves nothing').toHaveLength(3)
    for (const id of returned) {
      expect(b.idIndex.isKnownFor('PORTAL_B', id), `${id} was returned but not recorded`).toBe(true)
    }

    // Every one of them is then refused when a write to a DIFFERENT portal reuses it.
    const verdicts = returned.map((id) => {
      const plan = h.draftPlan('PORTAL_A', {
        kind: 'update',
        objectType: 'deals',
        objectId: id,
        properties: { dealname: 'X' },
      })
      return `${id}: ${h.validatePlan(plan.id).status}`
    })
    expect(verdicts).toEqual(returned.map((id) => `${id}: invalid`))
  })

  it('compares what it recorded, not HubSpot: a record live in both portals but read in one is refused in the other', async () => {
    const b = build()
    const h = createHandlers(b.deps)
    const inA = { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' }
    const inB = { token: 'tok-PORTAL_B', apiHost: 'api.hubapi.com' }
    const a = await b.client.createObject(inA, 'deals', { dealname: 'A' })
    const bRec = await b.client.createObject(inB, 'deals', { dealname: 'B' })
    // The same id is LIVE in both portals. Read straight off the client, which does not
    // feed the index, so "live" and "recorded" stay distinguishable.
    expect(a.id).toBe(bRec.id)
    expect((await b.client.getObject(inA, 'deals', a.id)).properties.dealname).toBe('A')

    await h.getRecord({ portalKey: 'PORTAL_B', objectType: 'deals', objectId: bRec.id })
    expect(b.idIndex.isKnownFor('PORTAL_B', bRec.id)).toBe(true)
    expect(b.idIndex.isKnownFor('PORTAL_A', a.id)).toBe(false)

    // The write names a record that really is in PORTAL_A, and is refused anyway. This is
    // the direction #203 corrected: the page used to say such a write was "not flagged".
    const plan = h.draftPlan('PORTAL_A', {
      kind: 'update',
      objectType: 'deals',
      objectId: a.id,
      properties: { dealname: 'X' },
    })
    const v = h.validatePlan(plan.id)
    expect(v.status).toBe('invalid')
    expect(v.validation?.issues.join(' ')).toContain('PORTAL_B')
  })

  it('the remedy works: reading the record in the target portal lets the next draft through', async () => {
    const b = build()
    const h = createHandlers(b.deps)
    const inA = { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' }
    const inB = { token: 'tok-PORTAL_B', apiHost: 'api.hubapi.com' }
    const a = await b.client.createObject(inA, 'deals', { dealname: 'A' })
    const bRec = await b.client.createObject(inB, 'deals', { dealname: 'B' })
    expect(a.id).toBe(bRec.id)
    const write = {
      kind: 'update' as const,
      objectType: 'deals',
      objectId: a.id,
      properties: { dealname: 'X' },
    }

    await h.getRecord({ portalKey: 'PORTAL_B', objectType: 'deals', objectId: bRec.id })
    const refused = h.draftPlan('PORTAL_A', write)
    expect(
      h.validatePlan(refused.id).status,
      'nothing was refused, so there is no remedy to prove',
    ).toBe('invalid')

    // The documented remedy, which #203 added because the one the page used to give was
    // unreachable: read the record in the portal you are writing to, then draft AGAIN.
    await h.getRecord({ portalKey: 'PORTAL_A', objectType: 'deals', objectId: a.id })
    const retry = h.draftPlan('PORTAL_A', write)
    expect(h.validatePlan(retry.id).status).toBe('validated')
    // "Draft again" and not "retry": the refused plan stays refused, which is why the
    // remedy has to be a new draft.
    expect(h.showPlan(refused.id).status).toBe('invalid')
  })

  it('an id inside a property value of a record you read is not recorded, so copying it is not caught', async () => {
    const b = build()
    const h = createHandlers(b.deps)
    const inB = { token: 'tok-PORTAL_B', apiHost: 'api.hubapi.com' }
    // The sanctioned placeholder. A 7-to-9 digit number that is not this one reads as a
    // real hub id to the assembly's shipped-surface scan, and src/** ships wholesale.
    const carried = '123456789'
    const seeded = await b.client.createObject(inB, 'deals', {
      dealname: 'B',
      linked_deal_id: carried,
    })

    const out = await h.getRecord({
      portalKey: 'PORTAL_B',
      objectType: 'deals',
      objectId: seeded.id,
      properties: ['dealname', 'linked_deal_id'],
    })
    // The value really did reach the assistant, which is what makes the gap a gap.
    expect(out.record.properties.linked_deal_id).toBe(carried)
    // The record's OWN id is attributed; the id sitting inside a value is not (#185).
    expect(b.idIndex.isKnownFor('PORTAL_B', seeded.id), 'the recorder did not run').toBe(true)
    expect(b.idIndex.isKnownFor('PORTAL_B', carried)).toBe(false)

    // So copying that value into another portal passes the check, exactly as disclosed.
    const plan = h.draftPlan('PORTAL_A', {
      kind: 'create',
      objectType: 'deals',
      properties: { dealname: 'D', linked_deal_id: carried },
    })
    expect(h.validatePlan(plan.id).status).toBe('validated')
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

  /**
   * THE HEADING TEST for `public/docs/SAFETY.md`'s "There is no direct write tool." (#201).
   *
   * Registered in scripts/claims-register.json. The ticket's evidence is that of the tools
   * this server registers, only `execute_plan` reaches a mutating HubSpot method, so the
   * assertion is exactly that: the set of tools that caused a mutation, measured, is
   * `['execute_plan']`.
   *
   * Written as an EQUALITY rather than as "no tool wrote", which carries its own
   * non-vacuity: a run in which nothing mutated — because the fixture was wrong, or the
   * counter blind — fails here instead of passing as a clean bill of health. That is the
   * #124 shape arriving in a test of my own.
   *
   * The portal is permissive and the arguments are VALID on purpose. A tool refused at
   * draft writes nothing for a reason this sentence is not about, so every call is
   * required to succeed; the assertion that all of them did is what makes the empty
   * mutation column mean "cannot write" rather than "never ran". The argument table is
   * checked against the advertised tool list, so a tool added tomorrow fails this test
   * instead of being skipped by it.
   */
  it('exactly one registered tool reaches a HubSpot write: execute_plan', async () => {
    const MUTATIONS = ['createObject', 'updateObject', 'createDefaultAssociation']
    const WRITABLE = ['notes', 'tasks', 'calls', 'meetings', 'deals', 'contacts']
    const config = loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            allowedObjects: WRITABLE,
            allowedOperations: ['create', 'update'],
            applyAllowedObjects: WRITABLE,
          },
        },
        writeMode: 'apply',
      }),
    )
    const registry = new PortalRegistry(config)
    const hubspot = new FakeHubSpotClient()
    const idIndex = new PortalIdIndex()
    const audit = new InMemoryAuditLog()
    const resolveToken = (k: string): string => `tok-${k}`
    const plans = new PlanService({
      registry,
      client: hubspot,
      idIndex,
      audit,
      resolveToken,
      writeMode: 'apply',
    })
    const reads = new ReadService({ registry, client: hubspot, idIndex, resolveToken })
    const server = createMcpServer({ registry, plans, reads, audit })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    // Something to read and a pipeline to summarize, so the read tools answer rather than
    // erroring: a tool that failed says nothing about whether it can write.
    const ctx = { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' }
    const record = await hubspot.createObject(ctx, 'contacts', { email: 'a@example.com' })
    hubspot.seedPipelines('tok-PORTAL_A', 'deals', [
      { id: 'p', label: 'Sales', stages: [{ id: 's1', label: 'New', displayOrder: 0 }] },
    ])
    const note = {
      kind: 'create' as const,
      objectType: 'notes',
      properties: { hs_note_body: 'hi' },
    }
    const validated = (): string => {
      const p = plans.draft({ portalKey: 'PORTAL_A', operation: note })
      plans.validate(p.id)
      return p.id
    }
    const toApprove = validated()
    const ARGS: Record<string, Record<string, unknown>> = {
      list_portals: {},
      set_default_read_portal: { portal: 'PORTAL_A' },
      get_record: { portal: 'PORTAL_A', objectType: 'contacts', objectId: record.id },
      search_records: { portal: 'PORTAL_A', objectType: 'contacts' },
      recent_activity: { portal: 'PORTAL_A' },
      summarize_pipeline: { portal: 'PORTAL_A' },
      draft_plan: { portal: 'PORTAL_A', operation: note },
      add_note: { portal: 'PORTAL_A', body: 'hi' },
      create_task: { portal: 'PORTAL_A', subject: 'do it' },
      log_call: { portal: 'PORTAL_A', body: 'spoke' },
      log_meeting: { portal: 'PORTAL_A', title: 'met' },
      update_deal_stage: { portal: 'PORTAL_A', dealId: record.id, stageId: 's1' },
      validate_plan: { planId: plans.draft({ portalKey: 'PORTAL_A', operation: note }).id },
      inspect_plan_target: { planId: validated() },
      show_plan: { planId: validated() },
      approve_plan: { planId: toApprove, confirmation: `approve plan ${toApprove} for PORTAL_A` },
      execute_plan: { planId: validated() },
      get_audit_log: { portal: 'PORTAL_A' },
    }

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names.length).toBeGreaterThan(10)
    expect(
      Object.keys(ARGS).sort(),
      'a registered tool has no arguments here, so nothing says whether it writes',
    ).toEqual([...names].sort())

    const wrote: string[] = []
    const refused: string[] = []
    for (const name of names) {
      const before = hubspot.calls.filter((c) => MUTATIONS.includes(c.method)).length
      const r = await client.callTool({ name, arguments: ARGS[name] as never })
      if (r.isError === true) {
        refused.push(`${name}: ${(r.content as Array<{ text?: string }>)[0]?.text ?? ''}`)
      }
      if (hubspot.calls.filter((c) => MUTATIONS.includes(c.method)).length > before) {
        wrote.push(name)
      }
    }

    expect(refused, 'these tools were refused, so their write path was never entered').toEqual([])
    expect(wrote).toEqual(['execute_plan'])
    await client.close()
  }, 60_000)

  /**
   * SAFETY.md "There is no direct write tool.", the sentence (#201): "The assistant issues
   * each of these calls, including `approve_plan`."
   *
   * Registered in scripts/claims-register.json. TRUE and worth stating, because it is the
   * sentence a reader is most likely to disbelieve: the approval is not an operator-side
   * action this server mediates. So the whole lifecycle is driven here from the CLIENT
   * side, which is the assistant's position, and the approval phrase is taken from what
   * `show_plan` returned rather than computed by the test — the model needs no out-of-band
   * secret to issue the approval.
   *
   * The enumeration is checked before it is used: a lifecycle step missing from the tool
   * list would otherwise make the rest of this pass trivially.
   */
  it('every lifecycle step is a tool the assistant calls, approve_plan included', async () => {
    const LIFECYCLE = [
      'draft_plan',
      'validate_plan',
      'inspect_plan_target',
      'show_plan',
      'approve_plan',
      'execute_plan',
    ]
    const { registry, plans, reads, audit } = build('propose')
    const server = createMcpServer({ registry, plans, reads, audit })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    expect(
      tools
        .map((t) => t.name)
        .filter((n) => LIFECYCLE.includes(n))
        .sort(),
      'a lifecycle step is not in the tool list, so this proves nothing',
    ).toEqual([...LIFECYCLE].sort())

    const callJson = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await client.callTool({ name, arguments: args as never })
      const text = (r.content as Array<{ text?: string }>)[0]?.text ?? ''
      expect(r.isError, `${name} was refused: ${text}`).not.toBe(true)
      return text
    }
    const plan = JSON.parse(
      await callJson('draft_plan', {
        portal: 'PORTAL_A',
        operation: { kind: 'create', objectType: 'notes', properties: { hs_note_body: 'hi' } },
      }),
    ) as { id: string }
    await callJson('validate_plan', { planId: plan.id })
    const shown = JSON.parse(await callJson('show_plan', { planId: plan.id })) as {
      approvalPhrase: string
    }
    expect(shown.approvalPhrase).toBe(`approve plan ${plan.id} for PORTAL_A`)

    // The approval itself, issued as a tool call with the phrase the previous tool call
    // handed over.
    const approved = JSON.parse(
      await callJson('approve_plan', { planId: plan.id, confirmation: shown.approvalPhrase }),
    ) as { status: string; approvedBy?: string }
    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe(shown.approvalPhrase)
    await client.close()
  }, 60_000)

  /**
   * SAFETY.md "There is no direct write tool.", the clause "... the steps marked
   * destructive." (#201).
   *
   * Registered in scripts/claims-register.json as the provable HALF of a sentence whose
   * main clause is about another application. What your MCP client does with the marking
   * is an `observed` segment; WHICH steps carry it is this server's own doing and is
   * enumerable from the list the client is given.
   *
   * Asserted as the whole marked set rather than as "approve_plan is marked", so a third
   * tool quietly acquiring the annotation, or either of these two losing it, fails here.
   * The tool count is checked first: over an empty list the equality would be comparing
   * nothing.
   */
  it('approve_plan and execute_plan are the steps marked destructive', async () => {
    const { registry, plans, reads, audit } = build()
    const server = createMcpServer({ registry, plans, reads, audit })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(10)
    expect(
      tools
        .filter((t) => t.annotations?.destructiveHint === true)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['approve_plan', 'execute_plan'])
    await client.close()
  })

  /**
   * SAFETY.md "Updates can be read back against the target portal before they run.",
   * the sentence (#204): "Nothing requires it before approval, so you can be asked for the
   * approval phrase on a plan whose target has not been read."
   *
   * Registered in scripts/claims-register.json. The same gap as the "There is no direct
   * write tool." sentence about the approve-time ordering, asserted from the other side:
   * that one pins the PlanService gate order, this one pins the surface the operator is
   * asked through. The phrase has to be PRODUCED before anyone can be asked for it, and
   * `show_plan` produces it for a plan carrying no inspection at all.
   */
  it('show_plan hands over the approval phrase for a plan whose target has not been read', async () => {
    const b = build('propose')
    const server = createMcpServer({
      registry: b.registry,
      plans: b.plans,
      reads: b.reads,
      audit: b.audit,
    })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const seeded = await b.client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'Acme renewal' },
    )
    const callJson = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await client.callTool({ name, arguments: args as never })
      const text = (r.content as Array<{ text?: string }>)[0]?.text ?? ''
      expect(r.isError, `${name} was refused: ${text}`).not.toBe(true)
      return text
    }
    const plan = JSON.parse(
      await callJson('draft_plan', {
        portal: 'PORTAL_A',
        operation: {
          kind: 'update',
          objectType: 'deals',
          objectId: seeded.id,
          properties: { amount: '999' },
        },
      }),
    ) as { id: string; referencedIds?: string[] }
    // The plan DOES have a target, which is what makes the un-read state meaningful.
    expect(plan.referencedIds).toContain(seeded.id)
    await callJson('validate_plan', { planId: plan.id })

    const shown = JSON.parse(await callJson('show_plan', { planId: plan.id })) as {
      approvalPhrase: string
      inspection?: unknown
    }
    expect(shown.inspection).toBeUndefined()
    expect(shown.approvalPhrase).toBe(`approve plan ${plan.id} for PORTAL_A`)
    const approved = JSON.parse(
      await callJson('approve_plan', { planId: plan.id, confirmation: shown.approvalPhrase }),
    ) as { status: string; inspection?: unknown }
    expect(approved.status).toBe('approved')
    expect(approved.inspection).toBeUndefined()
    await client.close()
  }, 60_000)

  /**
   * SAFETY.md "Updates can be read back against the target portal before they run.",
   * the sentence (#204): "Read those carefully: they are arguments on the execute call, so
   * the ASSISTANT supplies them rather than you, and it can do so on a plan you have
   * already approved."
   *
   * Registered in scripts/claims-register.json. Two assertions about the SURFACE rather
   * than about the gates, which is why this is here and not in plans.test.ts: that the
   * waivers are model-authored ARGUMENTS with no operator-side switch — enumerated over
   * the whole tool list, so "they are arguments on the execute call" means on that call
   * and nowhere else — and that one of them still works after an approval.
   *
   * The approval is issued through the tool surface too, so the sequence is the one the
   * sentence describes: the operator approves, and the next call the assistant makes
   * carries the waiver.
   */
  it('the two waivers are arguments on execute_plan alone, and work on a plan already approved', async () => {
    const b = build('propose')
    const server = createMcpServer({
      registry: b.registry,
      plans: b.plans,
      reads: b.reads,
      audit: b.audit,
    })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(10)
    const propsOf = (name: string): string[] =>
      Object.keys(
        (
          (tools.find((t) => t.name === name)?.inputSchema ?? {}) as {
            properties?: Record<string, unknown>
          }
        ).properties ?? {},
      )
    expect(propsOf('execute_plan')).toEqual(
      expect.arrayContaining(['skipInspection', 'acceptMissingTargets']),
    )
    expect(
      tools
        .map((t) => t.name)
        .filter((n) =>
          propsOf(n).some((p) => p === 'skipInspection' || p === 'acceptMissingTargets'),
        ),
      'another tool carries a waiver argument, so "on the execute call" is not the whole truth',
    ).toEqual(['execute_plan'])

    const seeded = await b.client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'Acme renewal' },
    )
    const callJson = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await client.callTool({ name, arguments: args as never })
      const text = (r.content as Array<{ text?: string }>)[0]?.text ?? ''
      expect(r.isError, `${name} was refused: ${text}`).not.toBe(true)
      return text
    }
    const plan = JSON.parse(
      await callJson('draft_plan', {
        portal: 'PORTAL_A',
        operation: {
          kind: 'update',
          objectType: 'deals',
          objectId: seeded.id,
          properties: { amount: '999' },
        },
      }),
    ) as { id: string }
    await callJson('validate_plan', { planId: plan.id })
    await callJson('approve_plan', {
      planId: plan.id,
      confirmation: `approve plan ${plan.id} for PORTAL_A`,
    })

    // The target has still not been read. The ASSISTANT waives it, after the approval.
    const refused = await client.callTool({
      name: 'execute_plan',
      arguments: { planId: plan.id } as never,
    })
    expect((refused.content as Array<{ text?: string }>)[0]?.text ?? '').toMatch(
      /run inspect_plan_target first/,
    )
    const done = JSON.parse(
      await callJson('execute_plan', { planId: plan.id, skipInspection: true }),
    ) as { status: string }
    expect(done.status).toBe('executed')
    await client.close()
  }, 60_000)

  /**
   * THE HEADING TEST for `public/docs/SAFETY.md`'s "Every write names its portal." (#200).
   *
   * Registered in scripts/claims-register.json, and shaped by what that register is for.
   * The claim is UNIVERSAL, so this enumerates the write-drafting surface rather than
   * sampling one tool: a test that proved `add_note` requires a portal would leave the
   * word "Every" unexamined, which is exactly the mismatch class the register exists to
   * catch. #154 was that mismatch — docs claimed routing of every ACTION while it was
   * enforced for writes only.
   *
   * Asserted on the SCHEMA rather than by calling each tool with `portal` omitted. A call
   * missing `portal` is also missing that tool's other required arguments, so it would be
   * refused either way and the test would pass for a reason it did not check. `required`
   * naming `portal` is the property the sentence actually claims.
   */
  it('every write-drafting tool requires a portal, by its own schema', async () => {
    const WRITE_DRAFTING = [
      'draft_plan',
      'add_note',
      'create_task',
      'log_call',
      'log_meeting',
      'update_deal_stage',
    ]
    const { registry, plans, reads, audit } = build()
    const server = createMcpServer({ registry, plans, reads, audit })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const { tools } = await client.listTools()

    // NON-VACUITY FIRST. An enumeration that matched nothing would make every assertion
    // below pass trivially, which is #124's shape arriving in a test of my own.
    const found = tools.filter((t) => WRITE_DRAFTING.includes(t.name))
    expect(found.map((t) => t.name).sort()).toEqual([...WRITE_DRAFTING].sort())

    for (const t of found) {
      const required = (t.inputSchema as { required?: string[] }).required ?? []
      expect(required, `${t.name} does not require a portal`).toContain('portal')
    }
    await client.close()
  })

  /**
   * SAFETY.md "Errors are cleaned before you see them.", sentence 2 (#207): "Every error
   * raised while a tool is running is replaced by a message this server wrote, and an
   * unexpected one becomes a generic message that carries no response body and no token."
   *
   * Registered in scripts/claims-register.json. "Every" is the word under test, so this
   * drives a RAW (non-SafeError) throw through every registered tool rather than through
   * one of them: a test that proved `get_record` sanitizes would leave the quantifier
   * unexamined, which is the mismatch class the register exists to catch.
   *
   * The thrown message carries both things the sentence says do not come back — a response
   * body and a credential — so `no response body and no token` is asserted rather than
   * assumed. Equality with the generic string is the strong form of it: anything that
   * reached the caller from the throw, redacted or not, is a different string.
   *
   * ARGUMENTS ARE WRITTEN OUT, not generated from each tool's schema. A generated argument
   * is one that VALIDATES, and the generator in credential-echo.test.ts records why that
   * is not reachable for `draft_plan` (a `z.record` schema has no `properties` to walk, so
   * it emits `{}`). Here the cost would be worse than a blind spot: a call the schema
   * rejects never reaches a handler, so every assertion below would pass on a tool whose
   * error path was never entered. The list is checked against the registered tool names,
   * so a tool added tomorrow fails this test instead of being skipped by it.
   */
  it('every tool replaces a raw error with our own message, carrying no body and no token', async () => {
    const PAT = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')
    const RAW = `connect ECONNREFUSED api.hubapi.com {"status":500,"token":"${PAT}"}`
    const raise = (): never => {
      throw new Error(RAW)
    }

    // Every dependency method throws a raw Error. `requiredPortalSchema` is kept real
    // because `createMcpServer` calls it to BUILD the portal argument: without it there
    // is no schema to pass validation, and every call below would be rejected before a
    // handler ran — the vacuous version of this test.
    const throwing = <T extends object>(real: T, keep: readonly string[]): T =>
      new Proxy(real, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && keep.includes(prop)) {
            const fn = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown
            return fn.bind(target)
          }
          return raise
        },
      })

    const { registry, plans, reads } = build()
    const server = createMcpServer({
      registry: throwing(registry, ['requiredPortalSchema']),
      plans: throwing(plans, []),
      reads: throwing(reads, []),
      audit: { forPortal: raise, all: raise } as unknown as AuditQuery,
    })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    // Valid arguments for each tool, so each call reaches its handler and the dependency
    // throw is what answers it.
    const ARGS: Record<string, Record<string, unknown>> = {
      list_portals: {},
      set_default_read_portal: { portal: 'PORTAL_A' },
      get_record: { portal: 'PORTAL_A', objectType: 'contacts', objectId: '1' },
      search_records: { portal: 'PORTAL_A', objectType: 'contacts' },
      recent_activity: { portal: 'PORTAL_A' },
      summarize_pipeline: { portal: 'PORTAL_A' },
      draft_plan: {
        portal: 'PORTAL_A',
        operation: { kind: 'create', objectType: 'notes', properties: { hs_note_body: 'hi' } },
      },
      add_note: { portal: 'PORTAL_A', body: 'hi' },
      create_task: { portal: 'PORTAL_A', subject: 'do it' },
      log_call: { portal: 'PORTAL_A', body: 'spoke' },
      log_meeting: { portal: 'PORTAL_A', title: 'met' },
      update_deal_stage: { portal: 'PORTAL_A', dealId: '1', stageId: '2' },
      validate_plan: { planId: 'plan_x' },
      inspect_plan_target: { planId: 'plan_x' },
      show_plan: { planId: 'plan_x' },
      approve_plan: { planId: 'plan_x', confirmation: 'approve plan plan_x for PORTAL_A' },
      execute_plan: { planId: 'plan_x' },
      get_audit_log: { portal: 'PORTAL_A' },
    }

    // NON-VACUITY FIRST, twice over: the tool list must be the one the server advertises,
    // and every advertised tool must be called. An enumeration that covered none of them
    // would make every assertion below pass trivially (#124).
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names.length).toBeGreaterThan(10)
    expect(
      Object.keys(ARGS).sort(),
      'a registered tool has no arguments here, so its error path is untested',
    ).toEqual([...names].sort())

    const answers: Array<{ name: string; text: string; isError: boolean }> = []
    for (const name of names) {
      const r = await client.callTool({ name, arguments: ARGS[name] as never })
      const text = (r.content as Array<{ text?: string }>)[0]?.text ?? ''
      answers.push({ name, text, isError: r.isError === true })
    }
    expect(answers).toHaveLength(names.length)

    expect(
      answers.filter((a) => a.text.includes('status') || a.text.includes(PAT)).map((a) => a.name),
      'these tools returned the response body or the credential from the raw throw',
    ).toEqual([])
    expect(
      answers
        .filter((a) => !a.isError || a.text !== 'an internal error occurred')
        .map((a) => `${a.name}: ${a.text}`),
      'these tools answered with something other than this server own generic message',
    ).toEqual([])
    await client.close()
  }, 60_000)

  /**
   * SAFETY.md "Errors are cleaned before you see them.", sentence 3 (#207): "A call that
   * does not match a tool's input schema is refused by the protocol layer before the tool
   * runs, and that refusal quotes the argument names you sent."
   *
   * Registered in scripts/claims-register.json. This is the sentence the page used to get
   * WRONG in the other direction: it claimed only this server's own messages reach the
   * assistant, while the bundled SDK answers a schema rejection out of the zod issue list,
   * and an issue path carries the caller's own property names. The claim is now that
   * weaker true thing, so the test asserts the quoting rather than denying it.
   *
   * "Before the tool runs" is asserted as an audit delta of zero. Draft records an event
   * whether it succeeds or is refused (see the draft-refusal block in plans.test.ts), so a
   * handler that ran would leave a line behind. Absence of the line is the evidence.
   */
  it('a schema-mismatched call is refused before the tool runs, quoting the argument names sent', async () => {
    const { registry, plans, reads, audit } = build()
    const server = createMcpServer({ registry, plans, reads, audit })
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const before = audit.all().length
    // `properties` is a record of STRINGS, so two numeric values are two schema issues,
    // and each issue's path ends in the property name the caller chose.
    let text: string
    try {
      const r = await client.callTool({
        name: 'draft_plan',
        arguments: {
          portal: 'PORTAL_A',
          operation: {
            kind: 'create',
            objectType: 'notes',
            properties: { my_own_field: 7, another_field_of_mine: 9 },
          },
        } as never,
      })
      text = JSON.stringify(r)
    } catch (e) {
      // A request-level rejection is thrown at the client rather than returned. It is
      // still what the assistant sees, so it counts the same here.
      text = String(e)
    }

    expect(text, 'nothing came back, so this test proves nothing').not.toBe('')
    expect(text).toContain('my_own_field')
    expect(text).toContain('another_field_of_mine')
    expect(
      audit.all().length - before,
      'the handler ran, so this was not refused before the tool',
    ).toBe(0)
    await client.close()
  }, 60_000)
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
