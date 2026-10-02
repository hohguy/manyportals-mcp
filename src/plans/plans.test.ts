import { describe, it, expect } from 'vitest'
import { FakeConfigProvider, loadConfig, type WriteMode } from '../config/index.js'
import { PortalRegistry } from '../portals/index.js'
import { FakeHubSpotClient } from '../hubspot/fake.js'
import { HubSpotError } from '../hubspot/index.js'
import { PortalIdIndex } from '../safety/index.js'
import { InMemoryAuditLog, type AuditEvent } from '../audit/index.js'
import { SafeError } from '../errors/index.js'
import {
  PlanService,
  WritePlanError,
  expectedApprovalPhrase,
  type WriteOperation,
} from './index.js'

// Permissive write policy for the existing tests (the policy itself is tested separately).
const TEST_OBJECTS = ['notes', 'deals', 'contacts', 'tasks']
const TEST_POLICY = {
  allowedObjects: TEST_OBJECTS,
  allowedOperations: ['create', 'update'] as const,
  applyAllowedObjects: TEST_OBJECTS,
}

function setup(opts?: {
  writeMode?: WriteMode
  perPortalWriteMode?: Record<string, WriteMode>
  allowWriteB?: boolean
  blockedPropsA?: string[]
  audit?: InMemoryAuditLog
  /** Inject an id-index (e.g. one whose refresh() throws) — peer of `audit` above. */
  idIndex?: PortalIdIndex
  /** Use PlanService's real plan-id generator instead of the deterministic test one. */
  defaultIds?: boolean
}) {
  const config = loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: {
          tokenEnv: 'A',
          expectedHubId: 111,
          label: 'Portal A',
          allowWrite: true,
          blockedProperties: opts?.blockedPropsA ?? [],
          ...TEST_POLICY,
        },
        PORTAL_B: {
          tokenEnv: 'B',
          expectedHubId: 222,
          label: 'Portal B',
          allowWrite: opts?.allowWriteB ?? true,
          ...TEST_POLICY,
        },
      },
      writeMode: opts?.writeMode ?? 'propose',
    }),
  )
  const registry = new PortalRegistry(config)
  const client = new FakeHubSpotClient()
  const idIndex = opts?.idIndex ?? new PortalIdIndex()
  const audit = opts?.audit ?? new InMemoryAuditLog()
  let n = 0
  const svc = new PlanService({
    registry,
    client,
    idIndex,
    audit,
    resolveToken: (k) => `tok-${k}`,
    writeMode: opts?.writeMode ?? 'propose',
    perPortalWriteMode: opts?.perPortalWriteMode,
    now: () => 1000,
    ...(opts?.defaultIds ? {} : { genId: () => `plan_${++n}` }),
  })
  return { svc, registry, client, idIndex, audit }
}

const createNote: WriteOperation = {
  kind: 'create',
  objectType: 'notes',
  properties: { hs_note_body: 'hi' },
}

/**
 * An audit sink that records the event (mem-first, like FileAuditLog) and THEN throws
 * for a chosen event type — modelling production FileAuditLog, whose disk append can
 * throw (ENOSPC/EACCES) where InMemoryAuditLog never does. Guards the invariant that a
 * failing sink on a SUCCESS-path record must not also emit a contradictory `deny`.
 */
class ThrowingAudit extends InMemoryAuditLog {
  constructor(private readonly throwOnType: AuditEvent['type']) {
    super()
  }
  override record(event: AuditEvent): void {
    super.record(event)
    if (event.type === this.throwOnType) throw new Error('audit sink write failed')
  }
}

/**
 * An id-index whose refresh() throws — modelling FilePortalIdIndex when a sibling copy's
 * trail cannot be read (a corrupt line, EACCES). `findContamination` refreshes BEFORE it
 * checks anything, so this is exactly what a store failure looks like at validate time.
 * Peer of ThrowingAudit above. A SafeError, because publicErrorMessage collapses anything
 * it does not recognise to a generic string — a plain Error would make the recorded reason
 * untestable.
 */
class ThrowingIdIndex extends PortalIdIndex {
  override refresh(): void {
    throw new SafeError('id-index unreadable')
  }
}

describe('draft — the explicit-portal gate', () => {
  it('refuses an empty portal key', () => {
    const { svc } = setup()
    expect(() => svc.draft({ portalKey: '', operation: createNote })).toThrow(WritePlanError)
  })
  it('refuses an unknown portal', () => {
    const { svc } = setup()
    expect(() => svc.draft({ portalKey: 'PORTAL_Z', operation: createNote })).toThrow()
  })
  it('refuses when writeMode is off', () => {
    const { svc } = setup({ writeMode: 'off' })
    expect(() => svc.draft({ portalKey: 'PORTAL_A', operation: createNote })).toThrow(/off/)
  })
  it('refuses a read-only portal (allowWrite=false)', () => {
    const { svc } = setup({ allowWriteB: false })
    expect(() => svc.draft({ portalKey: 'PORTAL_B', operation: createNote })).toThrow(/read-only/)
  })
})

describe('plan ids are never reused after a restart (#22)', () => {
  it('an approval phrase given before a restart cannot approve a different plan after it', () => {
    // Two PlanService instances stand in for the same server before and after a restart.
    const before = setup({ defaultIds: true })
    const stale = before.svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    const stalePhrase = expectedApprovalPhrase(stale.id, 'PORTAL_A')

    const after = setup({ defaultIds: true })
    const fresh = after.svc.draft({
      portalKey: 'PORTAL_A',
      operation: { ...createNote, properties: { hs_note_body: 'a different note' } },
    })
    after.svc.validate(fresh.id)

    expect(fresh.id).not.toBe(stale.id)
    expect(() => after.svc.approve(fresh.id, stalePhrase)).toThrow(/exact/)
    expect(after.svc.get(fresh.id).status).toBe('validated')
  })

  it('ids stay unique within one server', () => {
    const { svc } = setup({ defaultIds: true })
    const ids = new Set(
      Array.from(
        { length: 5 },
        () => svc.draft({ portalKey: 'PORTAL_A', operation: createNote }).id,
      ),
    )
    expect(ids.size).toBe(5)
  })
})

describe('propose mode — human approval required between validate and execute', () => {
  it('blocks execute until approved, then executes', async () => {
    const { svc } = setup({ writeMode: 'propose' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/requires approval/)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    const done = await svc.execute(p.id)
    expect(done.status).toBe('executed')
    expect(done.result?.objectId).toBeTruthy()
  })

  it('approval requires the EXACT "approve plan <id> for <portalKey>" phrase', () => {
    const { svc } = setup()
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    // loose / substring phrases are rejected (the old includes() weakness)
    expect(() => svc.approve(p.id, 'approve the canadian one')).toThrow(/exact/)
    expect(() => svc.approve(p.id, 'do not approve PORTAL_A')).toThrow(/exact/)
    expect(() => svc.approve(p.id, 'approve PORTAL_A now')).toThrow(/exact/)
    // naming the wrong portal is rejected
    expect(() => svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_B'))).toThrow(/exact/)
    // the exact phrase (tolerating surrounding whitespace) passes
    expect(() => svc.approve(p.id, ` ${expectedApprovalPhrase(p.id, 'PORTAL_A')} `)).not.toThrow()
  })
})

describe('apply mode — standing pre-authorization, but the pipeline still runs (AR-3)', () => {
  it('a validated plan executes without a separate approval', async () => {
    const { svc } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    expect((await svc.execute(p.id)).status).toBe('executed')
  })
  it('cannot execute an unvalidated draft (no pipeline shortcut)', async () => {
    const { svc } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    await expect(svc.execute(p.id)).rejects.toThrow(/validated before execution/)
  })
  it('honors a per-portal writeMode override', async () => {
    const { svc } = setup({ writeMode: 'propose', perPortalWriteMode: { PORTAL_A: 'apply' } })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    expect((await svc.execute(p.id)).status).toBe('executed')
  })
})

describe('contamination — cross-portal id references are rejected', () => {
  it('validate rejects a write referencing a foreign-portal id, and execute is blocked', async () => {
    const { svc, idIndex } = setup({ writeMode: 'apply' })
    idIndex.record('PORTAL_A', '500') // server saw id 500 under A
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: '500',
      properties: { dealstage: 'x' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_B', operation: op })
    const v = svc.validate(p.id)
    expect(v.status).toBe('invalid')
    expect(v.validation?.ok).toBe(false)
    await expect(svc.execute(p.id)).rejects.toThrow(/failed validation/)
  })

  it('records a created object id under its portal, feeding the contamination index', async () => {
    const { svc, idIndex } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    const newId = (await svc.execute(p.id)).result!.objectId!
    expect(idIndex.isKnownFor('PORTAL_A', newId)).toBe(true)

    // A later write to PORTAL_B referencing that id is now contamination.
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'notes',
      objectId: newId,
      properties: { hs_note_body: 'x' },
    }
    const p2 = svc.draft({ portalKey: 'PORTAL_B', operation: op })
    expect(svc.validate(p2.id).status).toBe('invalid')
  })
})

describe('write policy — default-deny allowedObjects/allowedOperations (P1.1)', () => {
  const policyConfig = (policy: {
    allowedObjects?: string[]
    allowedOperations?: Array<'create' | 'update'>
    applyAllowedObjects?: string[]
  }) =>
    loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            ...policy,
          },
        },
        writeMode: 'apply',
      }),
    )
  const svcFor = (config: ReturnType<typeof policyConfig>) =>
    new PlanService({
      registry: new PortalRegistry(config),
      client: new FakeHubSpotClient(),
      idIndex: new PortalIdIndex(),
      audit: new InMemoryAuditLog(),
      resolveToken: (k) => `tok-${k}`,
      writeMode: 'apply',
    })

  it('refuses an object type not in allowedObjects', () => {
    const svc = svcFor(policyConfig({ allowedObjects: ['notes'], allowedOperations: ['create'] }))
    expect(() =>
      svc.draft({
        portalKey: 'PORTAL_A',
        operation: { kind: 'create', objectType: 'deals', properties: {} },
      }),
    ).toThrow(/allowedObjects/)
  })

  it('refuses an operation kind not in allowedOperations', () => {
    const svc = svcFor(policyConfig({ allowedObjects: ['deals'], allowedOperations: ['create'] }))
    expect(() =>
      svc.draft({
        portalKey: 'PORTAL_A',
        operation: { kind: 'update', objectType: 'deals', objectId: '1', properties: {} },
      }),
    ).toThrow(/allowedOperations/)
  })

  it('allows a write whose object + operation are both allowlisted', () => {
    const svc = svcFor(policyConfig({ allowedObjects: ['notes'], allowedOperations: ['create'] }))
    expect(() => svc.draft({ portalKey: 'PORTAL_A', operation: createNote })).not.toThrow()
  })

  it('default-deny: a writable portal with empty allowlists can write nothing', () => {
    const svc = svcFor(policyConfig({})) // allowWrite true, but allowedObjects/Operations empty
    expect(() => svc.draft({ portalKey: 'PORTAL_A', operation: createNote })).toThrow(
      /allowedObjects/,
    )
  })
})

// Shared PORTAL_A apply-mode PlanService fixture (used by the P1.6 and N4 blocks).
// `policy` is spread into the portal; `client` defaults to a fresh fake.
function applyModeSvc(
  policy: {
    allowedObjects?: string[]
    allowedOperations?: Array<'create' | 'update'>
    applyAllowedObjects?: string[]
  },
  client: FakeHubSpotClient = new FakeHubSpotClient(),
) {
  const config = loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: {
          tokenEnv: 'A',
          expectedHubId: 111,
          label: 'Portal A',
          allowWrite: true,
          ...policy,
        },
      },
      writeMode: 'apply',
    }),
  )
  return new PlanService({
    registry: new PortalRegistry(config),
    client,
    idIndex: new PortalIdIndex(),
    audit: new InMemoryAuditLog(),
    resolveToken: (k) => `tok-${k}`,
    writeMode: 'apply',
  })
}

describe('apply auto-execute is bounded to applyAllowedObjects (P1.6)', () => {
  const svcWith = (applyAllowedObjects: string[]) =>
    applyModeSvc({ allowedObjects: ['notes'], allowedOperations: ['create'], applyAllowedObjects })

  it('apply auto-executes an object that IS blessed for apply', async () => {
    const svc = svcWith(['notes'])
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    expect((await svc.execute(p.id)).status).toBe('executed')
  })

  it('apply still requires approval for an object NOT blessed for apply', async () => {
    const svc = svcWith([]) // notes writable, but not apply-blessed
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/requires approval/)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    expect((await svc.execute(p.id)).status).toBe('executed')
  })
})

describe('plan operation is immutable after draft (P1.3)', () => {
  it('freezes the stored operation so a caller reference cannot mutate it post-draft', () => {
    const { svc } = setup()
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'hi' },
    }
    const plan = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    // mutating the ORIGINAL input object must not affect the stored plan
    op.properties.hs_note_body = 'tampered'
    op.objectType = 'deals'
    expect(svc.get(plan.id).operation).toEqual({
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'hi' },
    })
    // the returned snapshot's operation is frozen (defensive)
    const snap = svc.get(plan.id)
    expect(() => {
      ;(snap.operation as { objectType: string }).objectType = 'x'
    }).toThrow()
  })

  it('get() returns a defensive copy — mutating it cannot alter service state', () => {
    const { svc } = setup()
    const plan = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    const snap = svc.get(plan.id)
    snap.status = 'executed'
    snap.referencedIds.push('999')
    expect(svc.get(plan.id).status).toBe('draft')
    expect(svc.get(plan.id).referencedIds).toEqual([])
  })
})

describe('blocked-property policy — sensitive fields are rejected at validate', () => {
  it('rejects a write touching a blocked property pattern (before approval)', () => {
    const { svc } = setup({ blockedPropsA: ['hs_*sensitive*'] })
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'contacts',
      properties: { hs_super_sensitive_ssn: '123', email: 'x@example.com' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    const v = svc.validate(p.id)
    expect(v.status).toBe('invalid')
    expect(v.validation?.issues.join(' ')).toMatch(/hs_super_sensitive_ssn/)
  })

  it('allows a write with only non-blocked properties', () => {
    const { svc } = setup({ blockedPropsA: ['hs_*sensitive*'] })
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'contacts',
      properties: { email: 'x@example.com' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    expect(svc.validate(p.id).status).toBe('validated')
  })
})

describe('partial-write failure — orphan side effects are captured, not hidden', () => {
  it('records the created object id and surfaces it in the failure audit when association fails', async () => {
    class FailAssocClient extends FakeHubSpotClient {
      override async createDefaultAssociation(): Promise<void> {
        throw new HubSpotError('association step failed', 500)
      }
    }
    const config = loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            ...TEST_POLICY,
          },
        },
        writeMode: 'propose',
      }),
    )
    const registry = new PortalRegistry(config)
    const idIndex = new PortalIdIndex()
    const audit = new InMemoryAuditLog()
    const svc = new PlanService({
      registry,
      client: new FailAssocClient(),
      idIndex,
      audit,
      resolveToken: (k) => `tok-${k}`,
      writeMode: 'propose',
    })
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'hi' },
      associations: [{ toType: 'contacts', toId: '99' }],
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    // skip the inspection here (honored in propose) — targets partial-write capture, not P1.5
    await expect(svc.execute(p.id, { skipInspection: true })).rejects.toThrow(
      /association step failed/,
    )

    const plan = svc.get(p.id)
    expect(plan.status).toBe('failed')
    // the orphaned object id is preserved on the plan and in the failure audit
    const orphanId = plan.result?.objectId
    expect(orphanId).toBeTruthy()
    expect(plan.result?.error).toMatch(/association step failed/)
    expect(idIndex.isKnownFor('PORTAL_A', orphanId!)).toBe(true)
    const failEvent = audit.forPlan(p.id).find((e) => e.type === 'fail')
    expect(failEvent?.detail?.partialObjectId).toBe(orphanId)
  })
})

describe('error sanitization — unknown client errors are genericized (P2.3)', () => {
  it('does not surface a raw (non-SafeError) message into plan.result/audit', async () => {
    class LeakyClient extends FakeHubSpotClient {
      override async createObject(): Promise<never> {
        // a raw error whose message could carry a token/body if surfaced verbatim
        throw new Error('boom: Bearer pat-na1-SECRET in response body 123-45-6789')
      }
    }
    const config = loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            ...TEST_POLICY,
          },
        },
        writeMode: 'apply',
      }),
    )
    const audit = new InMemoryAuditLog()
    const svc = new PlanService({
      registry: new PortalRegistry(config),
      client: new LeakyClient(),
      idIndex: new PortalIdIndex(),
      audit,
      resolveToken: (k) => `tok-${k}`,
      writeMode: 'apply',
    })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow()
    const failEvent = audit.forPlan(p.id).find((e) => e.type === 'fail')
    expect(failEvent?.detail?.error).toBe('an internal error occurred')
    expect(svc.get(p.id).result?.error).toBe('an internal error occurred')
    expect(JSON.stringify(audit.all())).not.toContain('pat-')
  })
})

describe('target inspection for update/association targets (P1.5)', () => {
  const updateDeal: WriteOperation = {
    kind: 'update',
    objectType: 'deals',
    objectId: '900',
    properties: { amount: '999' },
  }

  it('a plan referencing an existing record must have its target inspected (or explicitly skipped) before execute', async () => {
    const { svc } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: updateDeal })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/run inspect_plan_target first|skipInspection/)
  })

  it('the inspection reads the target in the target portal and attaches a screened summary', async () => {
    const { svc, client, audit } = setup({ writeMode: 'apply', blockedPropsA: ['*secret*'] })
    // seed deal 900 under PORTAL_A's token
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'Acme renewal', deal_secret: 'hide-me' },
    )
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: seeded.id,
      properties: { amount: '999' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    const pf = await svc.inspectTarget(p.id)
    expect(pf.inspection?.results[0]?.found).toBe(true)
    expect(pf.inspection?.results[0]?.properties?.dealname).toBe('Acme renewal')
    expect(pf.inspection?.results[0]?.properties?.deal_secret).toBeUndefined() // blocked field screened out
    expect(audit.forPlan(p.id).map((e) => e.type)).toContain('inspect')
    // found target executes without further ceremony
    expect((await svc.execute(p.id)).status).toBe('executed')
  })

  // create-with-association: the new object is created and the (missing) association
  // target is recorded by the fake, so override/skip cleanly isolate the gate.
  const createWithAssoc: WriteOperation = {
    kind: 'create',
    objectType: 'notes',
    properties: { hs_note_body: 'hi' },
    associations: [{ toType: 'contacts', toId: '99' }], // 99 never seeded → not found in portal
  }

  it('flags a target NOT found in the target portal and refuses execute without acceptMissingTargets (propose)', async () => {
    const { svc } = setup({ writeMode: 'propose' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createWithAssoc })
    svc.validate(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    const pf = await svc.inspectTarget(p.id)
    expect(pf.inspection?.results[0]?.found).toBe(false)
    await expect(svc.execute(p.id)).rejects.toThrow(/not found in portal/)
    // explicit override proceeds (honored in propose; neutralized in apply per RT-02)
    expect((await svc.execute(p.id, { acceptMissingTargets: true })).status).toBe('executed')
  })

  it('explicit skipInspection bypasses the gate and is audited (propose)', async () => {
    const { svc, audit } = setup({ writeMode: 'propose' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createWithAssoc })
    svc.validate(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    expect((await svc.execute(p.id, { skipInspection: true })).status).toBe('executed')
    const pf = audit.forPlan(p.id).find((e) => e.type === 'inspect')
    expect(pf?.detail?.skipped).toBe(true)
  })

  it('propose mode works whether the inspection runs before OR after approve (no deadlock)', async () => {
    const { svc, client } = setup({ writeMode: 'propose' })
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'X' },
    )
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: seeded.id,
      properties: { amount: '999' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A')) // approve BEFORE the inspection
    await svc.inspectTarget(p.id) // still allowed on an approved plan
    expect((await svc.execute(p.id)).status).toBe('executed')
  })

  it('create-only plans (no referenced ids) do not require an inspection', async () => {
    const { svc } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    expect((await svc.execute(p.id)).status).toBe('executed') // no inspection needed
  })
})

describe('execute is single-flight — no double-write under concurrent calls (F1)', () => {
  it('rejects a second concurrent execute on the same plan; the CRM write happens once', async () => {
    const { svc, client } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    // Start two executes before the first one's await resolves (the SDK dispatches
    // requests concurrently). The first claims the plan ('executing') synchronously;
    // the second must be rejected.
    const settled = await Promise.allSettled([svc.execute(p.id), svc.execute(p.id)])
    const fulfilled = settled.filter((s) => s.status === 'fulfilled')
    const rejected = settled.filter((s) => s.status === 'rejected') // Promise status, not a plan status
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already executing/)
    // exactly one object created — not two
    expect(client.objectsFor('tok-PORTAL_A')).toHaveLength(1)
  })
})

describe('execute refuses while a target inspection is in flight (C1)', () => {
  it('rejects execute mid-inspection, then succeeds once the inspection completes', async () => {
    const { svc, client } = setup({ writeMode: 'apply' })
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'X' },
    )
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: seeded.id,
      properties: { amount: '999' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    const pf = svc.inspectTarget(p.id) // claimed synchronously; suspended on getObject
    await expect(svc.execute(p.id)).rejects.toThrow(/having its target inspected/)
    await pf // preflight completes, clears the in-flight flag
    expect((await svc.execute(p.id)).status).toBe('executed')
  })
})

describe('routing + audit', () => {
  it('routes execution to the resolved per-portal token', async () => {
    const { svc, client } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await svc.execute(p.id)
    expect(client.objectsFor('tok-PORTAL_A')).toHaveLength(1)
    expect(client.objectsFor('tok-PORTAL_B')).toHaveLength(0)
  })

  it('writes an append-only audit trail scoped to the portal', async () => {
    const { svc, audit } = setup({ writeMode: 'propose' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    await svc.execute(p.id)
    expect(audit.forPortal('PORTAL_A').map((e) => e.type)).toEqual([
      'draft',
      'validate',
      'approve',
      'attempt',
      'execute',
    ])
    expect(audit.forPortal('PORTAL_B')).toHaveLength(0)
  })
})

describe('audit completeness — refused approve/execute attempts are recorded as `deny`', () => {
  it('records a deny when execute is refused pre-approval (propose mode)', async () => {
    const { svc, audit } = setup({ writeMode: 'propose' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/requires approval/)
    const deny = audit.forPlan(p.id).find((e) => e.type === 'refused')
    expect(deny?.portalKey).toBe('PORTAL_A')
    expect(String(deny?.detail?.reason)).toMatch(/requires approval/)
  })

  it('records a deny when the id-index cannot be read at validate (#28)', () => {
    const audit = new InMemoryAuditLog()
    const { svc } = setup({ audit, idIndex: new ThrowingIdIndex() })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    // findContamination refreshes the index before checking, so a store read failure
    // surfaces here — the same failure execute already records as a deny.
    expect(() => svc.validate(p.id)).toThrow(/id-index unreadable/)
    const deny = audit.forPlan(p.id).find((e) => e.type === 'refused')
    expect(deny?.portalKey).toBe('PORTAL_A')
    expect(String(deny?.detail?.reason)).toMatch(/id-index unreadable/)
    // Fail-closed AND on the record: no validate/reject may claim a policy outcome
    // that was never actually computed.
    const types = audit.forPlan(p.id).map((e) => e.type)
    expect(types).not.toContain('validate')
    expect(types).not.toContain('reject')
  })

  it('records a deny when the approval phrase names the wrong portal', () => {
    const { svc, audit } = setup()
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    expect(() => svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_B'))).toThrow(/exact/)
    const deny = audit.forPlan(p.id).find((e) => e.type === 'refused')
    expect(deny?.portalKey).toBe('PORTAL_A')
    expect(String(deny?.detail?.reason)).toMatch(/exact/)
  })

  it('records a deny when a validation-rejected plan is pushed to execute', async () => {
    const { svc, audit } = setup({ writeMode: 'apply', blockedPropsA: ['*secret*'] })
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'create',
        objectType: 'notes',
        properties: { hs_note_body: 'x', my_secret: 'y' },
      },
    })
    svc.validate(p.id) // rejected: blocked property matched
    await expect(svc.execute(p.id)).rejects.toThrow(/failed validation/)
    expect(audit.forPlan(p.id).some((e) => e.type === 'refused')).toBe(true)
  })

  it('records a deny when execute is refused for a missing target', async () => {
    const { svc, audit } = setup({ writeMode: 'apply' })
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: '000000', // never seeded → preflight finds it absent in the portal
      properties: { amount: '999' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    await svc.inspectTarget(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/not found in portal/)
    const deny = audit.forPlan(p.id).find((e) => e.type === 'refused')
    expect(String(deny?.detail?.reason)).toMatch(/not found in portal/)
  })

  it('records a deny when contamination is caught at execute (defense in depth)', async () => {
    const { svc, audit, idIndex } = setup({ writeMode: 'propose' })
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: '55',
      properties: { amount: '999' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id) // passes: the index does not know id 55 yet
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    idIndex.record('PORTAL_B', '55') // 55 becomes a PORTAL_B id, learned post-approve
    // skipInspection (honored in propose) bypasses the record read to reach the
    // execute-time contamination re-check.
    await expect(svc.execute(p.id, { skipInspection: true })).rejects.toThrow(/belongs to/)
    expect(audit.forPlan(p.id).some((e) => e.type === 'refused')).toBe(true)
  })

  it('does NOT record a deny on a successful execute', async () => {
    const { svc, audit } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await svc.execute(p.id)
    expect(audit.forPlan(p.id).some((e) => e.type === 'refused')).toBe(false)
  })

  it('deny events never carry token material', async () => {
    const { svc, audit } = setup({ writeMode: 'propose' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow()
    expect(JSON.stringify(audit.all())).not.toContain('tok-')
  })

  // Regression guard: a SUCCESSFUL approval whose audit sink throws on the success
  // `approve` record must NOT also emit a contradictory `deny` (the success record
  // lives outside the deny-catch). InMemoryAuditLog never throws, so this needs a
  // sink that models production FileAuditLog's disk-append failure.
  it('a successful approval whose audit sink fails does NOT also emit a deny', () => {
    const audit = new ThrowingAudit('approve')
    const { svc } = setup({ audit })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    expect(() => svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))).toThrow(/sink/)
    const types = audit.forPlan(p.id).map((e) => e.type)
    expect(types).toContain('approve') // the success record landed in-memory
    expect(types).not.toContain('deny') // ...and no contradictory deny (the fix)
  })

  // Peer guard for execute(): the skipInspection/acceptMissingTargets choice is a
  // success-path record (outside the deny-catch), so a failing sink there must not
  // emit a spurious `deny` either.
  it('a successful skipInspection execute whose choice-audit fails does NOT emit a deny (propose)', async () => {
    const audit = new ThrowingAudit('inspect')
    const { svc } = setup({ writeMode: 'propose', audit })
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: '77',
      properties: { amount: '999' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    await expect(svc.execute(p.id, { skipInspection: true })).rejects.toThrow(/sink/)
    expect(audit.forPlan(p.id).map((e) => e.type)).not.toContain('deny')
  })
})

describe('a refusal at token resolution is audited like every other refusal', () => {
  it('records a deny when the token cannot be resolved at execute', async () => {
    // A portal configured without a token passes draft and validate, which never touch
    // credentials, and fails at execute. That is a refusal, so it must leave a trail.
    const { registry, client, idIndex, audit } = setup({ writeMode: 'apply' })
    const svc = new PlanService({
      registry,
      client,
      idIndex,
      audit,
      resolveToken: () => {
        throw new SafeError('no token for portal "PORTAL_A"')
      },
      writeMode: 'apply',
      now: () => 1000,
      genId: () => 'plan_token',
    })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/no token for portal/)
    const denies = audit.forPlan(p.id).filter((e) => e.type === 'refused')
    expect(denies).toHaveLength(1)
    expect(denies[0]?.detail?.reason).toMatch(/no token for portal/)
    // and nothing was attempted against HubSpot
    expect(audit.forPlan(p.id).some((e) => e.type === 'attempt')).toBe(false)
  })
})

describe('write-ahead audit durability — a write never happens without a durable trace (R4.1)', () => {
  it('records a durable `attempt` BEFORE the write', async () => {
    const { svc, audit } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await svc.execute(p.id)
    const types = audit.forPlan(p.id).map((e) => e.type)
    expect(types).toContain('attempt')
    expect(types.indexOf('attempt')).toBeLessThan(types.indexOf('execute')) // attempt precedes execute
  })

  it('FAILS CLOSED (no HubSpot write) if the audit sink cannot record the attempt', async () => {
    const audit = new ThrowingAudit('attempt')
    const { svc, client } = setup({ writeMode: 'apply', audit })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/could not durably record the attempt/)
    // The refusal happens BEFORE runOperation — nothing was written to HubSpot.
    expect(client.objectsFor('tok-PORTAL_A')).toHaveLength(0)
  })
})

describe('RT-01: portal-scoped reference properties are verified in the target portal', () => {
  const stagePipelines = [
    { id: 'default', label: 'Default', stages: [{ id: 'won', label: 'Won', displayOrder: 0 }] },
  ]

  it('refuses an update whose stage id is foreign to the target portal — non-waivable', async () => {
    const { svc, client } = setup({ writeMode: 'propose' })
    client.seedPipelines('tok-PORTAL_A', 'deals', stagePipelines) // A has "won", not "B_STAGE"
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'D' },
    )
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: seeded.id,
      properties: { dealstage: 'B_STAGE' }, // a stage id copied from another portal
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    await svc.inspectTarget(p.id)
    // even with BOTH lower-friction flags, the cross-portal stage is refused
    await expect(
      svc.execute(p.id, { skipInspection: true, acceptMissingTargets: true }),
    ).rejects.toThrow(/reference not valid|does not exist/)
  })

  it('gates a CREATE that sets a stage — preflight required even with no record target', async () => {
    const { svc, client } = setup({ writeMode: 'apply' })
    client.seedPipelines('tok-PORTAL_A', 'deals', stagePipelines)
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'deals',
      properties: { dealname: 'New', dealstage: 'won' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/verify it in the target portal/)
    await svc.inspectTarget(p.id) // stage "won" is present in A
    expect((await svc.execute(p.id)).status).toBe('executed')
  })

  it('refuses a generic write that sets an owner reference (at validate)', () => {
    const { svc } = setup({ writeMode: 'apply' })
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: '900',
      properties: { hubspot_owner_id: '55' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    const v = svc.validate(p.id)
    expect(v.status).toBe('invalid')
    expect(v.validation?.issues.join(' ')).toMatch(/hubspot_owner_id/)
  })

  it('does NOT treat a like-named property on a non-pipeline object type as a reference', async () => {
    // a `pipeline` property on `contacts` must NOT trigger getPipelines(contacts),
    // which would throw and brick the plan (per-type scoping).
    const { svc } = setup({ writeMode: 'apply' })
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'contacts',
      properties: { pipeline: 'anything', email: 'x@example.com' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    expect((await svc.execute(p.id)).status).toBe('executed')
  })
})

describe('RT-02: skipInspection/acceptMissingTargets are inert in apply auto-exec', () => {
  it('apply auto-exec still requires preflight even when skipInspection is requested', async () => {
    const { svc } = setup({ writeMode: 'apply' })
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: '900', // never seeded, never preflighted
      properties: { amount: '999' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    await expect(svc.execute(p.id, { skipInspection: true })).rejects.toThrow(
      /run inspect_plan_target first/,
    )
  })

  it('a neutralized flag is audited as the TRUTH (skipped=false, requestedFlagsIgnored=true)', async () => {
    const { svc, client, audit } = setup({ writeMode: 'apply' })
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'D' },
    )
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: seeded.id,
      properties: { amount: '999' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    await svc.inspectTarget(p.id) // the read runs despite the requested skip
    expect((await svc.execute(p.id, { skipInspection: true })).status).toBe('executed')
    const choice = audit
      .forPlan(p.id)
      .find((e) => e.type === 'inspect' && e.detail?.requestedFlagsIgnored !== undefined)
    expect(choice?.detail?.skipped).toBe(false) // never "skipped" when the read actually ran
    expect(choice?.detail?.requestedFlagsIgnored).toBe(true)
  })

  // #53: a refusal must not advise a waiver the gate ignores — a model that follows the
  // advice retries with the flag and is refused again, in a loop. The flags are neutralized
  // on AUTO-EXEC, which is keyed on the object type and not on approval: an apply-blessed
  // plan that an operator approved anyway still ignores them, while an apply-mode write that
  // needs approval honours them. Each case below fails if the message is keyed on the wrong
  // condition.
  const updateUnseeded: WriteOperation = {
    kind: 'update',
    objectType: 'deals',
    objectId: '900',
    properties: { amount: '999' },
  }
  const createWithMissingAssoc: WriteOperation = {
    kind: 'create',
    objectType: 'notes',
    properties: { hs_note_body: 'hi' },
    associations: [{ toType: 'contacts', toId: '99' }], // never seeded → not found
  }
  const applyNeedingApproval = () =>
    applyModeSvc({
      allowedObjects: TEST_OBJECTS,
      allowedOperations: ['create', 'update'],
      applyAllowedObjects: [],
    })

  async function refusalOf(
    svc: PlanService,
    op: WriteOperation,
    steps: { approve: boolean; inspect: boolean },
  ): Promise<string> {
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    // Approving an auto-exec plan is allowed and changes nothing; elsewhere it is required,
    // so the refusal under test is the preflight gate's.
    if (steps.approve) svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    if (steps.inspect) await svc.inspectTarget(p.id)
    return svc.execute(p.id).then(
      () => {
        throw new Error('expected execute to refuse')
      },
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
  }

  it('the missing-preflight refusal offers skipInspection only where it is honoured (#53)', async () => {
    for (const approve of [false, true]) {
      const auto = await refusalOf(setup({ writeMode: 'apply' }).svc, updateUnseeded, {
        approve,
        inspect: false,
      })
      expect(auto).toMatch(/run inspect_plan_target first/)
      expect(auto).toMatch(/skipInspection is ignored/)
      expect(auto).not.toMatch(/execute with skipInspection/)
    }

    for (const svc of [applyNeedingApproval(), setup({ writeMode: 'propose' }).svc]) {
      const honoured = await refusalOf(svc, updateUnseeded, { approve: true, inspect: false })
      expect(honoured).toMatch(/run inspect_plan_target first, or execute with skipInspection/)
    }
  })

  it('the missing-target refusal offers acceptMissingTargets only where it is honoured (#53)', async () => {
    for (const approve of [false, true]) {
      const auto = await refusalOf(setup({ writeMode: 'apply' }).svc, createWithMissingAssoc, {
        approve,
        inspect: true,
      })
      expect(auto).toMatch(/not found in portal "PORTAL_A": 99/)
      expect(auto).toMatch(/acceptMissingTargets is ignored/)
      expect(auto).not.toMatch(/execute with acceptMissingTargets/)
    }

    for (const svc of [applyNeedingApproval(), setup({ writeMode: 'propose' }).svc]) {
      const honoured = await refusalOf(svc, createWithMissingAssoc, {
        approve: true,
        inspect: true,
      })
      expect(honoured).toMatch(
        /not found in portal "PORTAL_A": 99 — .*or execute with acceptMissingTargets/,
      )
    }
  })
})

describe('RT-01 (N4): object-type aliasing does not escape reference verification', () => {
  const svcAllowing = (objectTypes: string[], client: FakeHubSpotClient) =>
    applyModeSvc(
      {
        allowedObjects: objectTypes,
        allowedOperations: ['create', 'update'],
        applyAllowedObjects: objectTypes,
      },
      client,
    )

  it('a deal addressed by its type-id (0-3) is still verified — a foreign stage is refused', async () => {
    const client = new FakeHubSpotClient()
    client.seedPipelines('tok-PORTAL_A', '0-3', [
      { id: 'default', label: 'D', stages: [{ id: 'won', label: 'W', displayOrder: 0 }] },
    ])
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      '0-3',
      { dealname: 'D' },
    )
    const svc = svcAllowing(['0-3'], client)
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: '0-3',
        objectId: seeded.id,
        properties: { dealstage: 'FOREIGN' },
      },
    })
    svc.validate(p.id)
    await svc.inspectTarget(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/reference not valid|does not exist/)
  })

  it('a pipeline-bearing custom object (2-XXXX) setting a reserved stage prop is denied at validate', () => {
    const svc = svcAllowing(['2-12345'], new FakeHubSpotClient())
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: '2-12345',
        objectId: '1',
        properties: { hs_pipeline_stage: 'FOREIGN' },
      },
    })
    const v = svc.validate(p.id)
    expect(v.status).toBe('invalid')
    expect(v.validation?.issues.join(' ')).toMatch(/unverifiable object type/)
  })

  /**
   * A CHARACTERIZATION test: it pins what the gate does NOT catch (#138).
   *
   * RESERVED_REFERENCE_PROPS holds `dealstage`, `hs_pipeline` and `hs_pipeline_stage`.
   * Bare `pipeline` is deliberately excluded, because it is a plausible name for a
   * customer's own property. So a custom object type setting `pipeline` is not denied
   * here, and SAFETY.md now says so instead of promising that it is.
   *
   * Two names in that table are inside HubSpot's `hs_` namespace and are unambiguous.
   * `dealstage` and `pipeline` are not, and only one of them is reserved. The asymmetry
   * is undefended either way, which is what #138 exists to settle; identifying a
   * reference property from the target portal's SCHEMA removes the question rather than
   * redrawing the line. Until then this test fails the moment that behaviour changes,
   * so the published sentence and the code cannot drift apart silently again.
   *
   * The test that would fire on a real fix is the one above. This one fires on an
   * accidental one.
   */
  it('a custom object setting bare `pipeline` is NOT denied, which SAFETY.md now states', () => {
    const svc = svcAllowing(['2-12345'], new FakeHubSpotClient())
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: '2-12345',
        objectId: '1',
        properties: { pipeline: 'FOREIGN' },
      },
    })
    const v = svc.validate(p.id)
    expect(v.validation?.issues.join(' ') ?? '').not.toMatch(/unverifiable object type/)
  })
})

/**
 * Every refusal is recorded. draft() had no try/catch at all and preflight()'s three
 * refusal paths bypassed its single record, so a model probing which object types a
 * portal accepts, or pushing repeatedly at a portal with writes disabled, left nothing
 * in the trail. validate() and execute() already audited this class, which is what
 * made the gap easy to miss, along with an audit-completeness block scoped to approve
 * and execute only (#84).
 */
describe('audit completeness — refusals at draft and preflight', () => {
  const note: WriteOperation = {
    kind: 'create',
    objectType: 'notes',
    properties: { hs_note_body: 'x' },
  }

  function denies(audit: InMemoryAuditLog): AuditEvent[] {
    return audit.all().filter((e) => e.type === 'refused')
  }

  it.each([
    ['a blank portal key', { portalKey: '   ', operation: note }],
    ['an unknown portal', { portalKey: 'PORTAL_NOPE', operation: note }],
    [
      'an object type outside allowedObjects',
      { portalKey: 'PORTAL_A', operation: { ...note, objectType: 'tickets' } },
    ],
  ])('records a deny when draft refuses %s', (_label, input) => {
    const { svc, audit } = setup()
    expect(() => svc.draft(input as { portalKey: string; operation: WriteOperation })).toThrow()
    const recorded = denies(audit)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.detail?.stage).toBe('draft')
    expect(recorded[0]?.planId).toBe('(refused-before-draft)')
  })

  it('records a deny when writes are disabled for the portal', () => {
    const { svc, audit } = setup({ writeMode: 'off' })
    expect(() => svc.draft({ portalKey: 'PORTAL_A', operation: note })).toThrow(/writeMode=off/)
    expect(denies(audit)).toHaveLength(1)
  })

  it('records a deny when the portal is read-only', () => {
    const { svc, audit } = setup({ allowWriteB: false })
    expect(() => svc.draft({ portalKey: 'PORTAL_B', operation: note })).toThrow(/read-only/)
    expect(denies(audit)).toHaveLength(1)
  })

  it('does not record a deny when the draft succeeds', () => {
    const { svc, audit } = setup()
    svc.draft({ portalKey: 'PORTAL_A', operation: note })
    expect(denies(audit)).toHaveLength(0)
  })

  it('redacts a credential-shaped portal key rather than writing it to the trail', () => {
    // The key is caller-supplied and the audit log is durable, so a token pasted where
    // a portal key belongs must not be persisted. Assembled from parts so this file is
    // not itself a credential-shaped surface.
    const token = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')
    const { svc, audit } = setup()
    expect(() => svc.draft({ portalKey: token, operation: note })).toThrow()
    const recorded = denies(audit)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.portalKey).not.toContain(token)
    expect(recorded[0]?.portalKey).not.toContain('0f2e4c6a')
    expect(JSON.stringify(recorded[0])).not.toContain('0f2e4c6a')
  })

  it('records a deny when preflight is called on a plan in the wrong status', async () => {
    const { svc, audit } = setup()
    const plan = svc.draft({ portalKey: 'PORTAL_A', operation: note }) // still draft
    await expect(svc.inspectTarget(plan.id)).rejects.toThrow(/validated or approved/)
    const recorded = denies(audit)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.detail?.stage).toBe('inspect')
    expect(recorded[0]?.planId).toBe(plan.id)
  })

  it('records a deny when preflight fails on a non-404 HubSpot error', async () => {
    const { svc, client, audit } = setup()
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'd' },
    )
    const plan = svc.draft({
      portalKey: 'PORTAL_A',
      operation: { kind: 'update', objectType: 'deals', objectId: seeded.id, properties: {} },
    })
    svc.validate(plan.id)
    client.failGetFor('tok-PORTAL_A', 'deals', new HubSpotError('upstream exploded', 500))
    await expect(svc.inspectTarget(plan.id)).rejects.toThrow()
    const recorded = denies(audit)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.detail?.stage).toBe('inspect')
  })
})
