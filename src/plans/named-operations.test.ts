import { describe, it, expect } from 'vitest'
import { FakeConfigProvider, loadConfig } from '../config/index.js'
import { PortalRegistry } from '../portals/index.js'
import { FakeHubSpotClient } from '../hubspot/fake.js'
import { PortalIdIndex } from '../safety/index.js'
import { InMemoryAuditLog } from '../audit/index.js'
import { PlanService, WritePlanError } from './index.js'
import {
  compileAddNote,
  compileCreateTask,
  compileLogCall,
  compileLogMeeting,
  compileUpdateDealStage,
} from './named-operations.js'

const T = '2026-07-05T12:00:00.000Z'

describe('named-operation compilers (pure mapping)', () => {
  it('add_note maps body + defaulted timestamp + associations', () => {
    const op = compileAddNote(
      { body: 'hello', associations: [{ toType: 'contacts', toId: '42' }] },
      T,
    )
    expect(op).toEqual({
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'hello', hs_timestamp: T },
      associations: [{ toType: 'contacts', toId: '42' }],
    })
  })

  it('an explicit timestamp wins over the default', () => {
    const op = compileAddNote({ body: 'x', at: '2026-01-01T00:00:00Z' }, T)
    expect(op.properties.hs_timestamp).toBe('2026-01-01T00:00:00Z')
  })

  it('create_task maps subject/body/status/priority and dueAt→hs_timestamp', () => {
    const op = compileCreateTask(
      {
        subject: 'Call back',
        body: 'details',
        dueAt: '2026-08-01',
        status: 'NOT_STARTED',
        priority: 'HIGH',
      },
      T,
    )
    expect(op).toEqual({
      kind: 'create',
      objectType: 'tasks',
      properties: {
        hs_task_subject: 'Call back',
        hs_task_body: 'details',
        hs_timestamp: '2026-08-01',
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'HIGH',
      },
      associations: undefined,
    })
  })

  it('omitted optionals never appear as properties (no undefined keys)', () => {
    const op = compileCreateTask({ subject: 'just a subject' }, T)
    expect(Object.keys(op.properties).sort()).toEqual(['hs_task_subject', 'hs_timestamp'])
  })

  it('log_call maps body/title/direction/duration', () => {
    const op = compileLogCall(
      { body: 'talked', title: 'Intro', direction: 'OUTBOUND', durationMs: '60000' },
      T,
    )
    expect(op.objectType).toBe('calls')
    expect(op.properties).toEqual({
      hs_call_body: 'talked',
      hs_call_title: 'Intro',
      hs_timestamp: T,
      hs_call_direction: 'OUTBOUND',
      hs_call_duration: '60000',
    })
  })

  it('log_meeting uses startAt for BOTH hs_timestamp and hs_meeting_start_time', () => {
    const op = compileLogMeeting(
      { title: 'Kickoff', startAt: '2026-09-01T10:00:00Z', endAt: '2026-09-01T11:00:00Z' },
      T,
    )
    expect(op.objectType).toBe('meetings')
    expect(op.properties).toEqual({
      hs_meeting_title: 'Kickoff',
      hs_timestamp: '2026-09-01T10:00:00Z',
      hs_meeting_start_time: '2026-09-01T10:00:00Z',
      hs_meeting_end_time: '2026-09-01T11:00:00Z',
    })
  })

  it('update_deal_stage compiles an UPDATE on the deal (pipeline only when given)', () => {
    expect(compileUpdateDealStage({ dealId: '7', stageId: 'won' })).toEqual({
      kind: 'update',
      objectType: 'deals',
      objectId: '7',
      properties: { dealstage: 'won' },
    })
    expect(
      compileUpdateDealStage({ dealId: '7', stageId: 'won', pipelineId: 'default' }).properties,
    ).toEqual({ dealstage: 'won', pipeline: 'default' })
  })
})

function setup() {
  const config = loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: {
          tokenEnv: 'A',
          expectedHubId: 111,
          label: 'Portal A',
          allowWrite: true,
          allowedObjects: ['notes', 'tasks', 'calls', 'meetings', 'deals'],
          allowedOperations: ['create', 'update'],
          applyAllowedObjects: ['notes', 'tasks', 'calls', 'meetings', 'deals'],
        },
        // PORTAL_B is writable but has an EMPTY allowlist — default-deny applies.
        PORTAL_B: { tokenEnv: 'B', expectedHubId: 222, label: 'Portal B', allowWrite: true },
      },
      writeMode: 'apply',
    }),
  )
  const registry = new PortalRegistry(config)
  const client = new FakeHubSpotClient()
  const svc = new PlanService({
    registry,
    client,
    idIndex: new PortalIdIndex(),
    audit: new InMemoryAuditLog(),
    resolveToken: (k) => `tok-${k}`,
    writeMode: 'apply',
  })
  return { svc, client }
}

describe('named operations go through the real lifecycle (no new mutation path)', () => {
  it('a compiled add_note drafts, validates, and executes into the named portal only', async () => {
    const { svc, client } = setup()
    const plan = svc.draft({
      portalKey: 'PORTAL_A',
      operation: compileAddNote({ body: 'note body' }, T),
    })
    svc.validate(plan.id)
    const done = await svc.execute(plan.id)
    expect(done.status).toBe('executed')
    const objects = client.objectsFor('tok-PORTAL_A')
    expect(objects).toHaveLength(1)
    expect(objects[0]?.properties.hs_note_body).toBe('note body')
    expect(client.objectsFor('tok-PORTAL_B')).toHaveLength(0) // nothing crossed portals
  })

  it('a compiled update_deal_stage passes the full inspection path and updates the deal', async () => {
    const { svc, client } = setup()
    // RT-01: the stage is verified against the target portal's pipelines by the inspection.
    client.seedPipelines('tok-PORTAL_A', 'deals', [
      { id: 'default', label: 'Default', stages: [{ id: 'won', label: 'Won', displayOrder: 0 }] },
    ])
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'D', dealstage: 'new' },
    )
    const plan = svc.draft({
      portalKey: 'PORTAL_A',
      operation: compileUpdateDealStage({ dealId: seeded.id, stageId: 'won' }),
    })
    svc.validate(plan.id)
    await svc.inspectTarget(plan.id) // references an existing record → the target read is required
    const done = await svc.execute(plan.id)
    expect(done.status).toBe('executed')
    const deal = client.objectsFor('tok-PORTAL_A').find((o) => o.id === seeded.id)
    expect(deal?.properties.dealstage).toBe('won')
  })

  it('default-deny still applies: a portal without the object allowlisted refuses the draft', () => {
    const { svc } = setup()
    expect(() =>
      svc.draft({
        portalKey: 'PORTAL_B',
        operation: compileCreateTask({ subject: 'nope' }, T),
      }),
    ).toThrow(WritePlanError)
  })
})
