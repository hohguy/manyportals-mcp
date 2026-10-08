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
  /** Inject a client (e.g. one whose association step throws) — peer of the two above. */
  client?: FakeHubSpotClient
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
  const client = opts?.client ?? new FakeHubSpotClient()
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
 * An audit sink that FAILS WITHOUT RECORDING for a chosen event type — the PRODUCTION
 * FileAuditLog shape. That sink persists to disk BEFORE memory (`src/audit/index.ts:257-266`),
 * so a disk failure means no line at all: EACCES after a permission flip, EMFILE, EIO, or
 * ENOENT if the data directory moved.
 *
 * ThrowingAudit above is the other shape — recorded, then threw. #183 is wrong under both,
 * and in opposite ways, so both are pinned here.
 */
class FailingAudit extends InMemoryAuditLog {
  constructor(private readonly failOnType: AuditEvent['type']) {
    super()
  }
  override record(event: AuditEvent): void {
    if (event.type === this.failOnType) throw new Error('audit sink write failed')
    super.record(event)
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

/**
 * An id-index whose refresh() throws only from the SECOND call on — which inside one
 * validate is the property tier's, the record-id tier having refreshed first. An index
 * that always threw would fail in findContamination and prove nothing about the second
 * tier, whose refresh is new at #176 and whose audit trail was the gap that arrived
 * with it.
 */
class LateThrowingIdIndex extends PortalIdIndex {
  private refreshes = 0
  override refresh(): void {
    if (++this.refreshes > 1) throw new SafeError('id-index unreadable')
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
  /**
   * Registered for `public/docs/SAFETY.md`'s "A selected or default portal does not stand
   * in for one." (#200). There was no test for that sentence at all.
   *
   * The selection is asserted to EXIST before the write is attempted. Without that, a
   * registry where `setSelected` silently did nothing would satisfy this test while
   * proving nothing about the fallback — the claim is that an available fallback is not
   * used, so the fallback has to be shown available.
   */
  it('a selected default portal does not stand in for a write', () => {
    const { svc, registry } = setup()
    registry.setSelected('PORTAL_B')
    expect(registry.getSelected()).toBe('PORTAL_B') // the fallback exists...
    // ...and a write still refuses rather than taking it.
    expect(() => svc.draft({ portalKey: '', operation: createNote })).toThrow(/explicit portal key/)
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

  /**
   * SAFETY.md "There is no direct write tool.", the sentence (#201): "Every change is
   * drafted as a plan and goes through `draft → validate → execute`, with an
   * `inspect_plan_target` step in between whenever the write touches an existing record
   * or sets a pipeline or stage."
   *
   * Registered in scripts/claims-register.json. One sentence, three assertions, so one
   * test exercises all three rather than one of them. The two inspection triggers are
   * SEPARATE code paths — a referenced record and a reference PROPERTY — and a test bound
   * to either alone would read as proving the sentence while half of it went unexamined.
   * The stage case is a CREATE on purpose: with no record target at all, it cannot be the
   * record gate arriving by another route.
   *
   * Each refusal is matched on its own reason rather than on the fact that something
   * threw, because a plan refused for any other cause would otherwise count as proof.
   */
  it('every change runs draft then validate then execute, and the inspection gates both conditions the page names', async () => {
    const { svc, client } = setup({ writeMode: 'apply' })
    client.seedPipelines('tok-PORTAL_A', 'deals', [
      { id: 'default', label: 'Default', stages: [{ id: 'won', label: 'Won', displayOrder: 0 }] },
    ])

    // THE ORDER: a draft cannot skip validate, and the same plan executes once it has.
    const plain = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    await expect(svc.execute(plain.id)).rejects.toThrow(/validated before execution/)
    svc.validate(plain.id)
    expect((await svc.execute(plain.id)).status).toBe('executed')

    // CONDITION 1 — the write touches an existing record.
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'D' },
    )
    const touching = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: 'deals',
        objectId: seeded.id,
        properties: { amount: '999' },
      },
    })
    svc.validate(touching.id)
    await expect(svc.execute(touching.id)).rejects.toThrow(/run inspect_plan_target first/)

    // CONDITION 2 — the write sets a stage, with no record target.
    const setsStage = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'create',
        objectType: 'deals',
        properties: { dealname: 'New', dealstage: 'won' },
      },
    })
    svc.validate(setsStage.id)
    await expect(svc.execute(setsStage.id)).rejects.toThrow(/verify it in the target portal/)

    // And the step in between is what clears both, which is what makes the two refusals
    // above the gate the sentence describes rather than a plan that could never run.
    await svc.inspectTarget(touching.id)
    await svc.inspectTarget(setsStage.id)
    expect((await svc.execute(touching.id)).status).toBe('executed')
    expect((await svc.execute(setsStage.id)).status).toBe('executed')
  })
})

describe('contamination — cross-portal id references are rejected', () => {
  /**
   * THE HEADING TEST for SAFETY.md's "A cross-portal check runs before writes." (#203),
   * registered in scripts/claims-register.json.
   *
   * "Before writes" is the whole heading, so the assertion is about what HubSpot saw, not
   * about what the plan's status became: a refusal that arrived after the write had gone
   * out would satisfy a status assertion and falsify the sentence.
   *
   * BOTH gates are exercised, because there are two ways to arrive at the write and the
   * heading covers both: the attribution can already be in the index at validate, or it
   * can land between validate and execute, which is the case a plan carrying a stale
   * finding would wave through. The write-ahead `attempt` line is checked as well as the
   * client, since a write is recorded before it is sent — its absence is the audit trail
   * agreeing that nothing was ever sent.
   */
  it('the check runs before the write: at either gate HubSpot is never called', async () => {
    const foreign = '123456789'
    const update: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: foreign,
      properties: { dealname: 'D' },
    }
    const mutations = (client: FakeHubSpotClient): string[] =>
      client.calls
        .filter((c) =>
          ['createObject', 'updateObject', 'createDefaultAssociation'].includes(c.method),
        )
        .map((c) => c.method)

    // GATE 1: the index already attributes the id to another portal at validate.
    const known = setup({ writeMode: 'apply' })
    known.idIndex.record('PORTAL_B', foreign)
    const p1 = known.svc.draft({ portalKey: 'PORTAL_A', operation: update })
    expect(known.svc.validate(p1.id).status).toBe('invalid')
    await expect(known.svc.execute(p1.id)).rejects.toThrow()

    // GATE 2: the attribution lands AFTER validate, so only the execute-time gate can
    // catch it. A plan that trusted its stored finding would write here.
    const late = setup({ writeMode: 'apply' })
    const p2 = late.svc.draft({ portalKey: 'PORTAL_A', operation: update })
    expect(late.svc.validate(p2.id).status).toBe('validated')
    late.idIndex.record('PORTAL_B', foreign)
    await expect(late.svc.execute(p2.id)).rejects.toThrow()

    // NON-VACUITY: the same fixture DOES reach HubSpot when nothing is contaminated, so
    // an empty call list above is the check working and not the fake refusing everything.
    const clean = setup({ writeMode: 'apply' })
    const p3 = clean.svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    clean.svc.validate(p3.id)
    expect((await clean.svc.execute(p3.id)).status).toBe('executed')
    expect(mutations(clean.client)).toEqual(['createObject'])

    expect(mutations(known.client), 'the write reached HubSpot despite the check').toEqual([])
    expect(mutations(late.client), 'the write reached HubSpot despite the check').toEqual([])
    for (const [label, a] of [
      ['known at validate', known],
      ['learned after validate', late],
    ] as const) {
      const types = a.audit.all().map((e: AuditEvent) => e.type)
      expect(types, `${label}: a write-ahead line exists, so a write was attempted`).not.toContain(
        'attempt',
      )
    }
  })

  /**
   * SAFETY.md "A cross-portal check runs before writes.", the sentence "It is an extra
   * layer rather than a guarantee, and it has limits you should know." (#203), registered
   * in scripts/claims-register.json.
   *
   * "Extra layer rather than a guarantee" is the testable half and it is tested from the
   * direction that makes it true: with NOTHING recorded the check contributes nothing at
   * all, and the write still goes to exactly the portal it named, because routing is the
   * layer underneath and it is what actually keeps portals apart. A reader who took this
   * check for the guarantee would believe an empty index meant an unprotected write.
   */
  it('is an extra layer: with nothing recorded it judges nothing, and routing still sends the write to the portal it named', async () => {
    const { svc, idIndex, client } = setup({ writeMode: 'apply' })
    expect(idIndex.isKnownFor('PORTAL_A', '123456789')).toBe(false)
    expect(idIndex.isKnownFor('PORTAL_B', '123456789')).toBe(false)

    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    const v = svc.validate(p.id)
    expect(v.status).toBe('validated')
    expect(v.suspectedCrossPortalRefs).toEqual([]) // nothing recorded, so nothing judged
    expect((await svc.execute(p.id)).status).toBe('executed')

    const writes = client.calls.filter((c) => c.method === 'createObject')
    expect(writes, 'no write was made, so this proves nothing').toHaveLength(1)
    expect([...new Set(writes.map((c) => c.token))]).toEqual(['tok-PORTAL_A'])
  })

  /**
   * SAFETY.md "A cross-portal check runs before writes.", the sentence "It judges only IDs
   * it has recorded, so an ID it has never returned is not judged at all." (#203),
   * registered in scripts/claims-register.json.
   *
   * The id here genuinely EXISTS in the other portal — it is seeded in that portal's own
   * state in the fake — and no read has ever returned it, which is the exact condition the
   * sentence describes. `findContamination`'s unit test pins the same limitation over a
   * bare index; this one pins the consequence for a write, and its CONTROL is what makes it
   * mean anything: record the attribution and the identical write is refused.
   */
  it('judges only recorded ids: an id live in another portal but never read goes through', async () => {
    /** An id that genuinely exists in PORTAL_B, seeded directly rather than read. */
    const liveInB = async (client: FakeHubSpotClient): Promise<string> =>
      (
        await client.createObject({ token: 'tok-PORTAL_B', apiHost: 'api.hubapi.com' }, 'deals', {
          dealname: 'B',
        })
      ).id
    const carrying = (id: string): WriteOperation => ({
      kind: 'create',
      objectType: 'deals',
      properties: { dealname: 'D', linked_deal_id: id },
    })

    const unread = setup({ writeMode: 'apply' })
    const id = await liveInB(unread.client)
    expect(unread.idIndex.isKnownFor('PORTAL_B', id), 'the seed recorded the id').toBe(false)
    const p = unread.svc.draft({ portalKey: 'PORTAL_A', operation: carrying(id) })
    expect(unread.svc.validate(p.id).status).toBe('validated')
    expect((await unread.svc.execute(p.id)).status).toBe('executed')

    // CONTROL, in its own fixture: the same id, RECORDED against the other portal, IS
    // judged. Its own fixture because the execute above records the id PORTAL_A assigned
    // to the new record, and an id both portals own is deliberately not flagged.
    const recorded = setup({ writeMode: 'apply' })
    const sameId = await liveInB(recorded.client)
    expect(sameId).toBe(id)
    recorded.idIndex.record('PORTAL_B', sameId)
    const p2 = recorded.svc.draft({ portalKey: 'PORTAL_A', operation: carrying(sameId) })
    expect(recorded.svc.validate(p2.id).status).toBe('invalid')
  })

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

  it('a write that succeeded is not recorded as failed when the id index cannot append', async () => {
    // #89. idIndex.record sat inside the try governing success, AFTER
    // plan.status = 'executed'. So an unwritable id-index.d while audit.d still worked
    // produced: the record EXISTS in the portal, plan.status === 'failed', and a trail
    // ending in `fail`. Two unrelated facts were conflated — whether HubSpot accepted
    // the write, and whether our own disk accepted the id.
    class BrokenIndex extends PortalIdIndex {
      override record(): void {
        throw new SafeError('id-index.d is not writable')
      }
    }
    const { svc, audit } = setup({ writeMode: 'apply', idIndex: new BrokenIndex() })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    const done = await svc.execute(p.id)

    // The write happened, so it is recorded as having happened.
    expect(done.status).toBe('executed')
    expect(done.result?.objectId).toBeTruthy()
    const types = audit.all().map((e: AuditEvent) => e.type)
    expect(types).toContain('execute')
    expect(types).not.toContain('fail')

    // And the degradation is VISIBLE. Swallowing it would be worse than the bug: the
    // cross-portal check is now blind to this id, and nothing else would say so.
    const ex = audit.all().find((e: AuditEvent) => e.type === 'execute')!
    expect(ex.detail?.indexed).toBe(false)
    expect(String((ex.detail?.indexErrors as string[])[0])).toContain('not writable')
  })

  it('reports the index failure on the failure path too, when a create is partial', async () => {
    // A create whose association step throws has already created the object. Whether its
    // id reached the index is exactly what an operator reconciling the orphan needs, so
    // the `fail` event carries it alongside partialObjectId.
    class BrokenIndex extends PortalIdIndex {
      override record(): void {
        throw new SafeError('id-index.d is not writable')
      }
    }
    class FailAssocClient extends FakeHubSpotClient {
      override async createDefaultAssociation(): Promise<void> {
        throw new HubSpotError('association step failed', 500)
      }
    }
    // PROPOSE, not apply: in apply auto-exec the requested flags are neutralized
    // (RT-02), so skipInspection below would be ignored and the plan refused at the
    // gate before reaching the write. Same reason the sibling test uses propose.
    const { svc, audit } = setup({
      writeMode: 'propose',
      idIndex: new BrokenIndex(),
      client: new FailAssocClient(),
    })
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'x' },
      associations: [{ toType: 'contacts', toId: '77' }],
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    svc.validate(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    // A create WITH associations touches an existing record, so the inspection gate
    // applies. Skipped deliberately: the target here is the partial-write path, not the
    // gate, which is the same choice the sibling partial-association test makes.
    await expect(svc.execute(p.id, { skipInspection: true })).rejects.toThrow()

    // Asserted as a list first, so a missing `fail` names what DID happen instead of
    // throwing on undefined (L10: a failing assertion must carry its evidence).
    expect(audit.all().map((e: AuditEvent) => e.type)).toContain('fail')
    const f = audit.all().find((e: AuditEvent) => e.type === 'fail')!
    expect(f.detail?.partialObjectId).toBeTruthy()
    expect(f.detail?.indexed).toBe(false)
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

describe('suspected cross-portal refs — a foreign id carried in a property VALUE', () => {
  /** A create carrying an id in a PROPERTY, which `referencedIds` does not look at. */
  const linkedTo = (value: string): WriteOperation => ({
    kind: 'create',
    objectType: 'deals',
    properties: { dealname: 'D', linked_deal_id: value },
  })

  it('catches a foreign id carried in a property value', async () => {
    // The verified counterexample. A read on PORTAL_B attributed id 123456789 to B;
    // this PORTAL_A create carries it in a property, and referencedIdsOf sees only the
    // update target and the association ids, so the plan validated and executed with
    // the attribution sitting unread in the index.
    const { svc, idIndex } = setup({ writeMode: 'apply' })
    idIndex.record('PORTAL_B', '123456789')
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo('123456789') })
    expect(p.referencedIds).toEqual([]) // the old surface is still blind to it
    const v = svc.validate(p.id)
    expect(v.status).toBe('invalid')
    expect(v.suspectedCrossPortalRefs).toEqual([
      { property: 'linked_deal_id', value: '123456789', owners: ['PORTAL_B'] },
    ])
    await expect(svc.execute(p.id)).rejects.toThrow(/failed validation/)
  })

  it('does NOT flag a note body that merely contains a foreign id', async () => {
    // The false-positive guard, and the reason the comparison is WHOLE-VALUE. Prose
    // quoting an id is not a reference to it, and a substring scan would refuse every
    // note that mentions one. In apply a false positive blocks a legitimate write with
    // no human to overrule it, so over-matching is the expensive direction here.
    const { svc, idIndex } = setup({ writeMode: 'apply' })
    idIndex.record('PORTAL_B', '123456789')
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'the matching record over at 123456789 was merged' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    const v = svc.validate(p.id)
    expect(v.status).toBe('validated')
    expect(v.suspectedCrossPortalRefs).toEqual([])
    expect((await svc.execute(p.id)).status).toBe('executed')
  })

  it('does NOT flag a value the target portal also owns', async () => {
    // The second false-positive guard, and it was MISSING from the brief this was built
    // from. findContamination skips an id the target portal also owns ("legitimately a
    // target id too"), and without the same skip here the heuristic tier that scans
    // ARBITRARY property values would have been stricter than the precise tier that
    // scans an enumerated reference set. Backwards: this tier is more exposed to two
    // portals happening to use the same integer, not less.
    const { svc, idIndex } = setup({ writeMode: 'apply' })
    idIndex.record('PORTAL_B', '123456789')
    idIndex.record('PORTAL_A', '123456789') // a real record in BOTH
    const op: WriteOperation = {
      kind: 'create',
      objectType: 'notes',
      properties: { hs_note_body: 'x', linked_deal_id: '123456789' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    const v = svc.validate(p.id)
    expect(v.status).toBe('validated')
    expect(v.suspectedCrossPortalRefs).toEqual([])
    expect((await svc.execute(p.id)).status).toBe('executed')
  })

  /**
   * SAFETY.md "A cross-portal check runs before writes.", the sentence about the values you
   * write into fields (#203), registered in scripts/claims-register.json.
   *
   * One sentence, two modes, so one test covers both: the summary sentence used to promise
   * a refusal in both, and #203's correction is that `propose` REPORTS the finding and lets
   * the write go ahead. The tests below pin each half separately as unit behaviour; the
   * sentence is only true as the pair, and a binding to either one alone would read as the
   * whole sentence being proven while the mode a reader is most likely to be running stayed
   * unexamined.
   *
   * "Before you approve" is asserted by reading the finding off the VALIDATED plan, with
   * approve called afterwards, and "allowed to go ahead" by the execute that follows.
   */
  it('a value that is exactly a foreign id is refused in apply, and reported but allowed in propose', async () => {
    const foreign = '123456789'

    const apply = setup({ writeMode: 'apply' })
    apply.idIndex.record('PORTAL_B', foreign)
    const pa = apply.svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo(foreign) })
    const va = apply.svc.validate(pa.id)
    expect(va.status).toBe('invalid')
    await expect(apply.svc.execute(pa.id)).rejects.toThrow()

    const propose = setup({ writeMode: 'propose' })
    propose.idIndex.record('PORTAL_B', foreign)
    const pp = propose.svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo(foreign) })
    const vp = propose.svc.validate(pp.id)
    // REPORTED on the plan, and reported BEFORE approve is called below.
    expect(vp.status).toBe('validated')
    expect(vp.suspectedCrossPortalRefs).toEqual([
      { property: 'linked_deal_id', value: foreign, owners: ['PORTAL_B'] },
    ])
    propose.svc.approve(pp.id, expectedApprovalPhrase(pp.id, 'PORTAL_A'))
    expect((await propose.svc.execute(pp.id)).status).toBe('executed')
    expect(
      propose.client.calls.filter((c) => c.method === 'createObject'),
      'the write did not go ahead, so the sentence is wrong in the other direction',
    ).toHaveLength(1)
  })

  it('propose surfaces the finding on the plan and still validates', () => {
    const { svc, idIndex, audit } = setup({ writeMode: 'propose' })
    idIndex.record('PORTAL_B', '123456789')
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo('123456789') })
    const v = svc.validate(p.id)
    expect(v.status).toBe('validated')
    expect(v.suspectedCrossPortalRefs).toEqual([
      { property: 'linked_deal_id', value: '123456789', owners: ['PORTAL_B'] },
    ])

    // SURFACED, not refused — and said so in the trail. The plan is still approvable,
    // so without this entry the finding would exist only in memory.
    const ev = audit.forPlan(p.id).find((e: AuditEvent) => e.type === 'validate')!
    expect(ev.detail?.suspectedRefsOutcome).toBe('surfaced')
    expect(ev.detail?.suspectedCrossPortalRefs).toHaveLength(1)
  })

  it('apply refuses an update whose property value belongs to another portal', () => {
    // An UPDATE, so the check is not create-only: here the update TARGET is clean and
    // only the property value is foreign, which is the half the contamination guard
    // cannot see.
    const { svc, idIndex } = setup({ writeMode: 'apply' })
    idIndex.record('PORTAL_B', '123456789')
    const op: WriteOperation = {
      kind: 'update',
      objectType: 'deals',
      objectId: '900', // never attributed to any portal
      properties: { linked_deal_id: '123456789' },
    }
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: op })
    const v = svc.validate(p.id)
    expect(v.status).toBe('invalid')
    // Actionable on its own: which property, which value, whose id it is.
    expect(v.validation?.issues).toHaveLength(1)
    expect(v.validation?.issues[0]).toContain('linked_deal_id')
    expect(v.validation?.issues[0]).toContain('123456789')
    expect(v.validation?.issues[0]).toContain('PORTAL_B')
  })

  it('leaves a write whose values match no foreign id untouched', async () => {
    const { svc, idIndex, audit } = setup({ writeMode: 'apply' })
    idIndex.record('PORTAL_A', '123456789') // the TARGET portal's own id, not foreign
    idIndex.record('PORTAL_B', '555') // a foreign id this write does not carry
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo('123456789') })
    const v = svc.validate(p.id)
    expect(v.status).toBe('validated')
    expect(v.suspectedCrossPortalRefs).toEqual([])
    const ev = audit.forPlan(p.id).find((e: AuditEvent) => e.type === 'validate')!
    expect(ev.detail).toBeUndefined() // a clean trail stays clean
    expect((await svc.execute(p.id)).status).toBe('executed')
  })

  it('refuses at execute when the index learned the attribution after validate', async () => {
    // Defence in depth, peer of the execute-time contamination re-check: the read that
    // attributes the value can land AFTER validate, so the list stored on the plan is
    // not the last word in apply mode.
    const { svc, idIndex, audit } = setup({ writeMode: 'apply' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo('123456789') })
    expect(svc.validate(p.id).status).toBe('validated') // the index knows nothing yet
    idIndex.record('PORTAL_B', '123456789')
    await expect(svc.execute(p.id)).rejects.toThrow(/owned by another portal/)
    const types = audit.forPlan(p.id).map((e: AuditEvent) => e.type)
    expect(types).toContain('refused')
    expect(types).not.toContain('attempt') // refused in the gates, before any write
  })

  it('propose refuses an entry the approved list never carried', async () => {
    // The #174 sequence. Validate ran before the index knew, so the operator typed the
    // approval phrase over an EMPTY list and judged nothing. Peer of the apply test
    // above, except that here the plan WAS explicitly approved and is refused anyway:
    // an approval cannot cover a finding it was never shown.
    const { svc, idIndex, audit } = setup({ writeMode: 'propose' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo('123456789') })
    const v = svc.validate(p.id)
    expect(v.status).toBe('validated')
    expect(v.suspectedCrossPortalRefs).toEqual([]) // nothing on the plan to judge

    idIndex.record('PORTAL_B', '123456789') // the read that teaches the attribution
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))

    const message = await svc.execute(p.id).then(
      () => {
        throw new Error('expected execute to refuse')
      },
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    // Actionable on its own: which property, which value, whose id it is — and why it
    // arrives after an approval the operator remembers giving.
    expect(message).toContain('linked_deal_id')
    expect(message).toContain('123456789')
    expect(message).toContain('PORTAL_B')
    expect(message).toMatch(/after the plan was approved/)
    const types = audit.forPlan(p.id).map((e: AuditEvent) => e.type)
    expect(types).toContain('refused')
    expect(types).not.toContain('attempt') // refused in the gates, before any write
  })

  it('propose still executes when the surfaced list is unchanged', async () => {
    // The other half, and the half that proves the refusal above did not simply break
    // propose mode: here the attribution is known BEFORE validate, so the finding is on
    // the plan the operator approves. Refusing it would silently overrule a decision
    // they are entitled to make, which is the defect the mode-aware reading exists to
    // avoid.
    const { svc, idIndex } = setup({ writeMode: 'propose' })
    idIndex.record('PORTAL_B', '123456789')
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo('123456789') })
    const v = svc.validate(p.id)
    expect(v.status).toBe('validated')
    expect(v.suspectedCrossPortalRefs).toEqual([
      { property: 'linked_deal_id', value: '123456789', owners: ['PORTAL_B'] },
    ])
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    expect((await svc.execute(p.id)).status).toBe('executed')
  })

  it('propose executes when only the owner list grew since approval', async () => {
    // Why the comparison keys on (property, value) and not on `owners`: a further portal
    // reading the same id widens that array, and a wider array is the same finding the
    // operator judged, not a new one. Keying on it would refuse a write they approved.
    const { svc, idIndex } = setup({ writeMode: 'propose' })
    idIndex.record('PORTAL_B', '123456789')
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: linkedTo('123456789') })
    expect(svc.validate(p.id).suspectedCrossPortalRefs).toEqual([
      { property: 'linked_deal_id', value: '123456789', owners: ['PORTAL_B'] },
    ])
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    idIndex.record('PORTAL_C', '123456789') // a third portal reads the same id
    expect((await svc.execute(p.id)).status).toBe('executed')
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

  /**
   * #189. checkDraftAllowed read `operation.objectType` and `operation.kind` and nothing
   * else, so an association's `toType` reached `createDefaultAssociation` without ever
   * being compared to the allow-list. A notes-only portal could attach a note to a deal,
   * and in `apply` mode it did so with no human in the loop. The allow-list is the
   * sentence SAFETY.md puts under "default-deny", and an association target is an object
   * type this write touches.
   *
   * WRITE side only. `allowedObjects` is a write policy; reads of a type that is not on
   * it were never gated by it and must keep working.
   */
  it('refuses an association whose target object type is not in allowedObjects', () => {
    const svc = svcFor(policyConfig({ allowedObjects: ['notes'], allowedOperations: ['create'] }))
    expect(() =>
      svc.draft({
        portalKey: 'PORTAL_A',
        operation: {
          kind: 'create',
          objectType: 'notes',
          properties: { hs_note_body: 'hi' },
          associations: [{ toType: 'deals', toId: '123456789' }],
        },
      }),
    ).toThrow(/allowedObjects/)
  })

  it('allows an association whose target object type IS on the allow-list', () => {
    const svc = svcFor(
      policyConfig({ allowedObjects: ['notes', 'contacts'], allowedOperations: ['create'] }),
    )
    expect(() =>
      svc.draft({
        portalKey: 'PORTAL_A',
        operation: {
          kind: 'create',
          objectType: 'notes',
          properties: { hs_note_body: 'hi' },
          associations: [{ toType: 'contacts', toId: '42' }],
        },
      }),
    ).not.toThrow()
  })

  /**
   * THE HEADING TEST for SAFETY.md's "Each portal has a default-deny policy." (#205),
   * registered in scripts/claims-register.json.
   *
   * Two words, and the single-portal tests above prove neither. "EACH portal" means the
   * policy is held per portal, so this configures three and writes the same two object
   * types at every one of them: PORTAL_A permits notes and refuses deals while PORTAL_B
   * does the opposite, which no single-portal fixture can show. "DEFAULT-deny" is
   * PORTAL_C, which carries no allow-lists at all and can write nothing.
   *
   * The grid is asserted whole rather than per portal, so a policy that refused
   * EVERYTHING would fail here too: the two `allowed` cells are what make the six
   * refusals mean something (#124).
   */
  it('every portal carries its own allow-lists, and a portal with none can write nothing', () => {
    const config = loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            allowedObjects: ['notes'],
            allowedOperations: ['create'],
          },
          PORTAL_B: {
            tokenEnv: 'B',
            expectedHubId: 222,
            label: 'Portal B',
            allowWrite: true,
            allowedObjects: ['deals'],
            allowedOperations: ['create'],
          },
          // Writable, and nothing is allow-listed: the DEFAULT.
          PORTAL_C: { tokenEnv: 'C', expectedHubId: 333, label: 'Portal C', allowWrite: true },
        },
        writeMode: 'apply',
      }),
    )
    const registry = new PortalRegistry(config)
    const svc = new PlanService({
      registry,
      client: new FakeHubSpotClient(),
      idIndex: new PortalIdIndex(),
      audit: new InMemoryAuditLog(),
      resolveToken: (k) => `tok-${k}`,
      writeMode: 'apply',
    })
    const properties: Record<string, Record<string, string>> = {
      notes: { hs_note_body: 'hi' },
      deals: { dealname: 'D' },
    }
    const attempt = (portalKey: string, objectType: string): string => {
      try {
        svc.draft({
          portalKey,
          operation: { kind: 'create', objectType, properties: properties[objectType] ?? {} },
        })
        return 'allowed'
      } catch {
        return 'refused'
      }
    }

    // NON-VACUITY: every CONFIGURED portal is in the grid, not a hand-picked two of them.
    expect(registry.keys()).toEqual(['PORTAL_A', 'PORTAL_B', 'PORTAL_C'])
    const grid = registry
      .keys()
      .flatMap((key) => ['notes', 'deals'].map((t) => `${key}/${t}: ${attempt(key, t)}`))
    expect(grid).toEqual([
      'PORTAL_A/notes: allowed',
      'PORTAL_A/deals: refused',
      'PORTAL_B/notes: refused',
      'PORTAL_B/deals: allowed',
      'PORTAL_C/notes: refused',
      'PORTAL_C/deals: refused',
    ])
  })

  /**
   * SAFETY.md "Each portal has a default-deny policy.", sentence 1 (#205): "A write is
   * refused unless its object type and operation are on that portal's allow-lists, and an
   * association's target object type has to be on the allow-list too."
   *
   * Registered in scripts/claims-register.json. Three gates in one sentence, so one test
   * exercises all three against ONE policy — the three unit tests above each pin a single
   * gate, and binding the sentence to any one of them would leave the other two unproven
   * while reading as if the sentence were covered. The association clause is the half #189
   * added: `allowedObjects` now bounds what a write can TOUCH, not only what it creates.
   *
   * The first case is the permitted one, and it is what makes the three refusals evidence:
   * without it a policy that refused every write would satisfy the rest of the list.
   */
  it('a write is refused unless its object type, its operation and its association targets are allow-listed', () => {
    const svc = svcFor(
      policyConfig({ allowedObjects: ['notes', 'contacts'], allowedOperations: ['create'] }),
    )
    const attempt = (operation: WriteOperation): string => {
      try {
        svc.draft({ portalKey: 'PORTAL_A', operation })
        return 'allowed'
      } catch {
        return 'refused'
      }
    }
    const cases: Array<[string, WriteOperation]> = [
      [
        'object type, operation and association target all allow-listed',
        {
          kind: 'create',
          objectType: 'notes',
          properties: { hs_note_body: 'hi' },
          associations: [{ toType: 'contacts', toId: '42' }],
        },
      ],
      [
        'the object type is not allow-listed',
        { kind: 'create', objectType: 'deals', properties: { dealname: 'D' } },
      ],
      [
        'the operation is not allow-listed',
        { kind: 'update', objectType: 'notes', objectId: '1', properties: { hs_note_body: 'hi' } },
      ],
      [
        "an association's target object type is not allow-listed",
        {
          kind: 'create',
          objectType: 'notes',
          properties: { hs_note_body: 'hi' },
          associations: [{ toType: 'deals', toId: '9' }],
        },
      ],
    ]
    expect(cases, 'no gate was exercised, so this proves nothing').toHaveLength(4)
    expect(cases.map(([label, op]) => `${label}: ${attempt(op)}`)).toEqual([
      'object type, operation and association target all allow-listed: allowed',
      'the object type is not allow-listed: refused',
      'the operation is not allow-listed: refused',
      "an association's target object type is not allow-listed: refused",
    ])
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

  /**
   * SAFETY.md "There is no direct write tool.", the sentence (#201): "In `apply` mode that
   * step is replaced, for the object types you list, by the standing allow-list described
   * under default-deny below."
   *
   * Registered in scripts/claims-register.json, and it is the clause the ticket exists
   * for: the page stated the lifecycle unconditionally, which is FALSE in apply mode for
   * a listed object type, where `approve` is not required at all.
   *
   * So the assertion is that the step is REPLACED rather than pre-satisfied — no `approve`
   * line in the trail and no `approvedBy` on the plan — and that the LIST is what decides,
   * by running the same create at a listed and an unlisted object type on one portal in
   * one mode. The two tests above pin the outcome for a blessed type and for the
   * complement and are bound to the default-deny bullet's own sentences; neither looks at
   * the trail, and "replaced" is a statement about the trail.
   */
  it('in apply mode the approval step is replaced for a listed object type and kept for the rest', async () => {
    const audit = new InMemoryAuditLog()
    const config = loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: {
            tokenEnv: 'A',
            expectedHubId: 111,
            label: 'Portal A',
            allowWrite: true,
            allowedObjects: ['notes', 'deals'],
            allowedOperations: ['create'],
            applyAllowedObjects: ['notes'], // deals is writable but NOT blessed for apply
          },
        },
        writeMode: 'apply',
      }),
    )
    const svc = new PlanService({
      registry: new PortalRegistry(config),
      client: new FakeHubSpotClient(),
      idIndex: new PortalIdIndex(),
      audit,
      resolveToken: (k) => `tok-${k}`,
      writeMode: 'apply',
    })

    // LISTED: the step is gone, not merely already satisfied.
    const listed = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(listed.id)
    const done = await svc.execute(listed.id)
    expect(done.status).toBe('executed')
    expect(done.approvedBy).toBeUndefined()
    expect(audit.forPlan(listed.id).map((e) => e.type)).toEqual([
      'draft',
      'validate',
      'attempt',
      'execute',
    ])

    // UNLISTED, same portal and same mode: the step is still there.
    const unlisted = svc.draft({
      portalKey: 'PORTAL_A',
      operation: { kind: 'create', objectType: 'deals', properties: { dealname: 'D' } },
    })
    svc.validate(unlisted.id)
    await expect(svc.execute(unlisted.id)).rejects.toThrow(/requires approval/)
    svc.approve(unlisted.id, expectedApprovalPhrase(unlisted.id, 'PORTAL_A'))
    expect((await svc.execute(unlisted.id)).status).toBe('executed')
    expect(audit.forPlan(unlisted.id).map((e) => e.type)).toContain('approve')
  })

  /**
   * SAFETY.md "Each portal has a default-deny policy.", the sentence "Everything else
   * still needs one." (#205), registered in scripts/claims-register.json.
   *
   * "Everything else" is the COMPLEMENT of `applyAllowedObjects`, so this enumerates it:
   * every object type the portal may write, minus the one blessed for apply, and each must
   * still stop at approval. The test above pins the same property for a single object type
   * and is bound to the sentence that states the rule; this one is bound to the sentence
   * that quantifies it, because a complement of one is the case a reader cannot generalise
   * from.
   *
   * The refusal is matched on `requires approval` rather than on "it threw": a plan refused
   * for any other reason would otherwise count as proof, which is the same trap as a guard
   * that passes because nothing ran.
   */
  it('in apply mode every object type outside applyAllowedObjects still needs an approval', async () => {
    const writable = ['notes', 'deals', 'contacts', 'tasks']
    const svc = applyModeSvc({
      allowedObjects: writable,
      allowedOperations: ['create'],
      applyAllowedObjects: ['notes'],
    })
    const outside = writable.filter((t) => t !== 'notes')
    expect(outside, 'the complement is empty, so this proves nothing').toEqual([
      'deals',
      'contacts',
      'tasks',
    ])

    const outcomes: string[] = []
    for (const objectType of outside) {
      const p = svc.draft({
        portalKey: 'PORTAL_A',
        operation: { kind: 'create', objectType, properties: { name: 'X' } },
      })
      svc.validate(p.id)
      let stopped = false
      try {
        await svc.execute(p.id)
      } catch (e) {
        stopped = /requires approval/.test(String(e))
      }
      outcomes.push(`${objectType}: ${stopped ? 'needs approval' : 'ran without one'}`)
    }
    expect(outcomes).toEqual([
      'deals: needs approval',
      'contacts: needs approval',
      'tasks: needs approval',
    ])
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

  /** The three HubSpot methods that change something. Read calls are not among them. */
  const MUTATIONS = ['createObject', 'updateObject', 'createDefaultAssociation']

  /** Seed one deal under PORTAL_A's token and return its id. */
  async function seededDeal(
    client: FakeHubSpotClient,
    properties: Record<string, string> = { dealname: 'Acme renewal' },
  ): Promise<string> {
    const obj = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      properties,
    )
    return obj.id
  }

  /**
   * THE HEADING TEST for SAFETY.md's "Updates can be read back against the target portal
   * before they run." (#204).
   *
   * Registered in scripts/claims-register.json. The heading is an ORDERING claim and a
   * ROUTING claim, so it is asserted on what HubSpot SAW rather than on what the plan
   * holds: a summary attached after the write had gone out would satisfy a plan-shaped
   * assertion and falsify the sentence. Same shape, and the same reason, as the
   * cross-portal bullet's heading claim.
   *
   * "Against the target portal" is the token the read went out under. The fake keys its
   * state by token, so a read under another portal's token could not have found this
   * record at all, and the recorded call says which one it was.
   *
   * The write afterwards is the NON-VACUITY control: it proves the mutation count can see
   * a mutation, so the zero before it is a measurement rather than an artefact.
   */
  it('the read-back reaches the named portal and happens before the write', async () => {
    const { svc, client } = setup({ writeMode: 'apply' })
    const dealId = await seededDeal(client)
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: 'deals',
        objectId: dealId,
        properties: { amount: '999' },
      },
    })
    svc.validate(p.id)

    const before = client.calls.filter((c) => MUTATIONS.includes(c.method)).length
    const inspected = await svc.inspectTarget(p.id)

    const reads = client.calls.filter((c) => c.method === 'getObject' && c.token === 'tok-PORTAL_A')
    expect(reads, 'no read reached the named portal, so this proves nothing').toHaveLength(1)
    expect(inspected.inspection?.results[0]?.properties?.dealname).toBe('Acme renewal')
    expect(
      client.calls.filter((c) => MUTATIONS.includes(c.method)).length - before,
      'the write went out during the read-back',
    ).toBe(0)

    // CONTROL: the same counter does see the write, so the zero above is a measurement.
    expect((await svc.execute(p.id)).status).toBe('executed')
    expect(client.calls.filter((c) => MUTATIONS.includes(c.method)).length - before).toBe(1)
  })

  /**
   * SAFETY.md "Updates can be read back against the target portal before they run.",
   * the sentence (#204): "If the portal's `blockedProperties` hide the fields that would
   * identify the record, the summary can come back holding little more than the ID you
   * supplied, so read what it returns rather than that it returned."
   *
   * Registered in scripts/claims-register.json. A CHARACTERIZATION of #188, so the test
   * asserts the gap rather than its absence: the summary comes back `found: true` carrying
   * no property at all, which is a confirmation an operator cannot act on. Ordinary
   * `blockedProperties` do it — nothing exotic is configured here.
   *
   * The control is the SAME record and the same plan under a portal with nothing blocked.
   * Without it, an inspection that had stopped returning properties altogether would read
   * as this limit being faithfully documented.
   */
  it('blockedProperties can reduce the summary to the id the caller supplied', async () => {
    const identifying = { dealname: 'Acme renewal' }
    const summaryUnder = async (blockedPropsA: string[]) => {
      const { svc, client } = setup({ writeMode: 'apply', blockedPropsA })
      const dealId = await seededDeal(client, identifying)
      const p = svc.draft({
        portalKey: 'PORTAL_A',
        operation: {
          kind: 'update',
          objectType: 'deals',
          objectId: dealId,
          properties: { amount: '999' },
        },
      })
      svc.validate(p.id)
      return { id: dealId, result: (await svc.inspectTarget(p.id)).inspection?.results[0] }
    }

    const hidden = await summaryUnder(['dealname'])
    expect(hidden.result?.found, 'the target was never found, so nothing is measured').toBe(true)
    expect(hidden.result?.id).toBe(hidden.id) // the id the caller supplied, and nothing else
    expect(hidden.result?.properties).toEqual({})

    // CONTROL: the same read with nothing blocked does identify the record.
    const shown = await summaryUnder([])
    expect(shown.result?.properties).toEqual(identifying)
  })

  /**
   * SAFETY.md "Updates can be read back against the target portal before they run.",
   * the sentence (#204): "It is required before executing a write that touches an existing
   * record, and for a write that sets a pipeline or stage it cannot be waived."
   *
   * Registered in scripts/claims-register.json. Two gates in one sentence with opposite
   * waivability, so one test runs both against one portal in one mode. The second clause
   * needed no wording change once #186 landed, and this is the case that says so.
   *
   * The waiver being HONOURED for the first write is what makes the second refusal
   * evidence: without it, a mode in which no waiver worked at all would satisfy the
   * "cannot be waived" half for the wrong reason.
   */
  it('the read is required for a write that touches an existing record, and cannot be waived for one that sets a stage', async () => {
    const { svc, client } = setup({ writeMode: 'propose' })
    client.seedPipelines('tok-PORTAL_A', 'deals', [
      { id: 'default', label: 'Default', stages: [{ id: 'won', label: 'Won', displayOrder: 0 }] },
    ])
    const dealId = await seededDeal(client)
    const approvedPlan = (properties: Record<string, string>): string => {
      const p = svc.draft({
        portalKey: 'PORTAL_A',
        operation: { kind: 'update', objectType: 'deals', objectId: dealId, properties },
      })
      svc.validate(p.id)
      svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
      return p.id
    }

    // REQUIRED: an approved plan that touches an existing record still stops here.
    const touching = approvedPlan({ amount: '999' })
    await expect(svc.execute(touching)).rejects.toThrow(/run inspect_plan_target first/)
    // ... and in this mode the waiver IS honoured, which is what makes the next case mean
    // something.
    expect((await svc.execute(touching, { skipInspection: true })).status).toBe('executed')

    // CANNOT BE WAIVED: the same waiver, on a write that sets a stage, changes nothing.
    const setsStage = approvedPlan({ dealstage: 'won' })
    await expect(
      svc.execute(setsStage, { skipInspection: true, acceptMissingTargets: true }),
    ).rejects.toThrow(/this check cannot be skipped/)
    await svc.inspectTarget(setsStage)
    expect((await svc.execute(setsStage)).status).toBe('executed')
  })

  /**
   * SAFETY.md "Updates can be read back against the target portal before they run.",
   * the sentence (#204): "For other writes `execute_plan` accepts `skipInspection` and
   * `acceptMissingTargets`."
   *
   * Registered in scripts/claims-register.json. The sentence names BOTH arguments, and
   * they waive two DIFFERENT gates — one the read itself, the other a read that ran and
   * found nothing — so one test exercises both. Binding this to the single-flag test above
   * would read as proving the sentence while half of it went unexamined.
   *
   * Each flag is shown refused first and accepted second on the same plan, so the
   * difference is the argument and not the fixture.
   */
  it('for other writes both execute arguments are accepted, each waiving its own gate', async () => {
    const { svc, client } = setup({ writeMode: 'propose' })
    const dealId = await seededDeal(client)
    const approved = (operation: WriteOperation): string => {
      const p = svc.draft({ portalKey: 'PORTAL_A', operation })
      svc.validate(p.id)
      svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
      return p.id
    }

    // skipInspection waives the read itself.
    const unread = approved({
      kind: 'update',
      objectType: 'deals',
      objectId: dealId,
      properties: { amount: '1' },
    })
    await expect(svc.execute(unread)).rejects.toThrow(/run inspect_plan_target first/)
    expect((await svc.execute(unread, { skipInspection: true })).status).toBe('executed')

    // acceptMissingTargets waives the OTHER gate: the read ran and found nothing.
    const missing = approved(createWithAssoc)
    await svc.inspectTarget(missing)
    await expect(svc.execute(missing)).rejects.toThrow(/not found in portal/)
    expect((await svc.execute(missing, { acceptMissingTargets: true })).status).toBe('executed')
  })

  /**
   * SAFETY.md "There is no direct write tool.", the sentence (#201): "Nothing requires the
   * target to be inspected before you approve, only before the write runs, so the approval
   * phrase can be asked for on a plan whose target has not been read yet."
   *
   * Registered in scripts/claims-register.json, and it is the finding the page disclosed
   * nowhere: `approve()` checks status and phrase and never looks at `plan.inspection`, so
   * the operator can be asked to type the phrase for a plan nobody has read the target of.
   *
   * Asserted in BOTH directions, because the sentence makes two statements: the approval
   * goes through with no `inspect` line behind it, and the gate that does exist arrives
   * afterwards, at execute.
   *
   * The same gap is stated again in the "Updates can be read back ..." bullet, where it is
   * bound to a test over the TOOL surface — whether the phrase can be PRODUCED for an
   * un-read plan — rather than over this service's gate order.
   */
  it('approve accepts a plan whose target was never read, and execute is where that is refused', async () => {
    const { svc, client, audit } = setup({ writeMode: 'propose' })
    const dealId = await seededDeal(client)
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: 'deals',
        objectId: dealId,
        properties: { amount: '999' },
      },
    })
    svc.validate(p.id)
    const approved = svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    expect(approved.status).toBe('approved')
    expect(approved.inspection).toBeUndefined()
    expect(audit.forPlan(p.id).map((e) => e.type)).not.toContain('inspect')

    // Only the write itself is gated on the read.
    await expect(svc.execute(p.id)).rejects.toThrow(/run inspect_plan_target first/)
  })

  /**
   * SAFETY.md "Updates can be read back against the target portal before they run.",
   * the sentence (#204): "A waiver is recorded when the write goes ahead; if the write is
   * refused for some other reason, the attempt to waive it is not recorded."
   *
   * Registered in scripts/claims-register.json. A CHARACTERIZATION of #191, so the test
   * asserts the gap: the waiver record sits AFTER the gate section, so an execute refused
   * by any other gate leaves no trace that a waiver was asked for.
   *
   * The second half is the non-vacuity control. The same waiver on a write that goes ahead
   * IS recorded, so the empty trail in the first half is evidence that nothing was written
   * rather than evidence that this test cannot see a waiver record.
   */
  it('a waiver is recorded when the write goes ahead, and not when the execute is refused for another reason', async () => {
    const { svc, audit } = setup({ writeMode: 'propose' })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createWithAssoc })
    svc.validate(p.id)

    // Refused by a DIFFERENT gate — want of approval — while a waiver was requested.
    await expect(svc.execute(p.id, { skipInspection: true })).rejects.toThrow(/requires approval/)
    expect(
      audit.forPlan(p.id).filter((e) => e.type === 'inspect'),
      'the refused execute recorded a waiver it never applied',
    ).toEqual([])

    // CONTROL: the same waiver, on a write that goes ahead, is recorded.
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    expect((await svc.execute(p.id, { skipInspection: true })).status).toBe('executed')
    const recorded = audit.forPlan(p.id).filter((e) => e.type === 'inspect')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.detail?.skipped).toBe(true)
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

  /**
   * SAFETY.md "There is no direct write tool.", the sentence (#201): "The lifecycle steps
   * are recorded."
   *
   * Registered in scripts/claims-register.json. This is the WEAKENED form the ticket
   * landed: "Each step is recorded" was an overclaim while #187 and #192 are open, and
   * what remains true is that every step of the lifecycle the bullet names leaves its own
   * line. So this enumerates them — `inspect` included, which the test above never
   * reaches and which sentence 1 names as part of the lifecycle.
   *
   * Asserted as the WHOLE trail rather than with `toContain`, so a step that stopped being
   * recorded fails here instead of being covered by its neighbours.
   */
  it('each lifecycle step the page names leaves its own line in the trail', async () => {
    const { svc, client, audit } = setup({ writeMode: 'propose' })
    const seeded = await client.createObject(
      { token: 'tok-PORTAL_A', apiHost: 'api.hubapi.com' },
      'deals',
      { dealname: 'D' },
    )
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: 'deals',
        objectId: seeded.id,
        properties: { amount: '999' },
      },
    })
    svc.validate(p.id)
    await svc.inspectTarget(p.id)
    svc.approve(p.id, expectedApprovalPhrase(p.id, 'PORTAL_A'))
    expect((await svc.execute(p.id)).status).toBe('executed')
    expect(audit.forPlan(p.id).map((e) => e.type)).toEqual([
      'draft',
      'validate',
      'inspect',
      'approve',
      'attempt',
      'execute',
    ])
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

  it('records a deny when the id-index cannot be read by the property tier at validate', () => {
    // Gap 5 of #176, and it was UNREACHABLE before the fix: the property tier never
    // refreshed, so it could not fail on a store read, so the catch that covers the
    // record-id tier did not need to cover it. Giving the tier its own refresh brings
    // the audit-trail gap with it, which is why one wrapper now covers both calls.
    const audit = new InMemoryAuditLog()
    const { svc } = setup({ audit, idIndex: new LateThrowingIdIndex() })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    expect(() => svc.validate(p.id)).toThrow(/id-index unreadable/)
    const deny = audit.forPlan(p.id).find((e) => e.type === 'refused')
    expect(deny?.portalKey).toBe('PORTAL_A')
    expect(String(deny?.detail?.reason)).toMatch(/id-index unreadable/)
    const types = audit.forPlan(p.id).map((e) => e.type)
    expect(types).not.toContain('validate')
    expect(types).not.toContain('invalid')
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

  /**
   * #183. The `attempt` marker above is fail-closed and correct. The OUTCOME records
   * were not: `audit.record({ type: 'execute' })` sat inside the try that governs the
   * HubSpot call, so a sink failure after a successful write was caught and handled as
   * a WRITE failure — status 'failed', the real object id relabelled `partialObjectId`
   * (the field that means "an orphan to clean up"), a `fail` event, and a rejection
   * telling the assistant the write did not happen.
   *
   * That is #89's defect one call site over. #89 wrapped `idIndex.record` in
   * `recordIdSafely` so an index failure could not change the write's recorded outcome.
   * The `audit.record` three lines below it has the identical shape and was never swept.
   *
   * Why it matters more than a lost log line: SAFETY.md tells the operator that an
   * `attempt` with no outcome means "check HubSpot", and calls that the ONE case where
   * the log does not answer the question. A `fail` reads as "it did not happen", so an
   * operator or an assistant acting on the log re-runs the write and doubles a record in
   * a live CRM.
   */
  it('a write that SUCCEEDED is not recorded as failed when its outcome line cannot be stored (#183)', async () => {
    const audit = new FailingAudit('execute')
    const { svc, client } = setup({ writeMode: 'apply', audit })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    const out = await svc.execute(p.id)
    // The write reached HubSpot, exactly once.
    expect(client.objectsFor('tok-PORTAL_A')).toHaveLength(1)
    // ...and the caller is told that, rather than being told it failed.
    expect(out.status).toBe('executed')
    const types = audit.forPlan(p.id).map((e) => e.type)
    // A sink that could not write the OUTCOME must not invent a verdict.
    expect(types).not.toContain('fail')
    // It degrades to the state SAFETY.md already documents: a durable `attempt` with no
    // outcome after it, meaning "this may or may not have happened, check HubSpot".
    expect(types).toContain('attempt')
  })

  it('does not record two contradictory outcomes for one write (#183)', async () => {
    // The other sink shape: the line IS persisted and the append then throws. Today the
    // catch records `fail` after `execute` already landed, so one write carries two
    // outcome events that disagree.
    const audit = new ThrowingAudit('execute')
    const { svc, client } = setup({ writeMode: 'apply', audit })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await svc.execute(p.id)
    expect(client.objectsFor('tok-PORTAL_A')).toHaveLength(1)
    const types = audit.forPlan(p.id).map((e) => e.type)
    expect(types).toContain('execute')
    expect(types).not.toContain('fail')
  })

  it('a genuine write failure still rejects with ITS OWN error when the `fail` line cannot be stored (#183)', async () => {
    // The mirror case, and the reason the fix has to cover both records. In the catch,
    // `audit.record({type:'fail'})` runs BEFORE `throw e`, so a throw from the sink
    // replaces the real error: the caller is told the audit failed and never learns why
    // the write did.
    class FailingCreateClient extends FakeHubSpotClient {
      override async createObject(): Promise<never> {
        throw new SafeError('the create was rejected')
      }
    }
    const audit = new FailingAudit('fail')
    const { svc } = setup({ writeMode: 'apply', audit, client: new FailingCreateClient() })
    const p = svc.draft({ portalKey: 'PORTAL_A', operation: createNote })
    svc.validate(p.id)
    await expect(svc.execute(p.id)).rejects.toThrow(/the create was rejected/)
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

  /**
   * #186. The gate was INVERTED: being on a KNOWN object type is what EXEMPTED a
   * reserved pipeline/stage name.
   *
   * `setsReferenceProperty` only ever looked up the write's own type pair from
   * RESOLVABLE_REFERENCE_PROPS, and `unverifiableReferencePropsIn` returned an empty
   * list the instant the type was recognised. A reserved name belonging to the OTHER
   * recognised type therefore matched neither set: a custom object setting `dealstage`
   * was denied at validate, while `tickets` setting `dealstage` validated clean and
   * executed with no pipeline resolution at all. Same for `deals` with
   * `hs_pipeline_stage` or `hs_pipeline`.
   *
   * The deals/tickets fixtures below use applyModeSvc because the shared setup's
   * allow-list carries no tickets.
   */
  const reservedSvc = (objectTypes: string[]) =>
    applyModeSvc({
      allowedObjects: objectTypes,
      allowedOperations: ['create', 'update'],
      applyAllowedObjects: objectTypes,
    })

  it('a reserved stage property belonging to the OTHER known type is denied at validate', () => {
    const svc = reservedSvc(['tickets'])
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: 'tickets',
        objectId: '1',
        properties: { dealstage: 'FOREIGN' },
      },
    })
    const v = svc.validate(p.id)
    expect(v.status).toBe('invalid')
    expect(v.validation?.issues.join(' ')).toMatch(/dealstage/)
  })

  it('a ticket stage or pipeline property set on deals is denied at validate', () => {
    const svc = reservedSvc(['deals'])
    for (const property of ['hs_pipeline_stage', 'hs_pipeline']) {
      const p = svc.draft({
        portalKey: 'PORTAL_A',
        operation: {
          kind: 'update',
          objectType: 'deals',
          objectId: '900',
          properties: { [property]: 'FOREIGN' },
        },
      })
      const v = svc.validate(p.id)
      expect(v.status).toBe('invalid')
      expect(v.validation?.issues.join(' ')).toContain(property)
    }
  })

  it('a ticket addressed by its type-id 0-5 does not escape the reserved-name check', () => {
    const svc = reservedSvc(['0-5'])
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: '0-5',
        objectId: '1',
        properties: { dealstage: 'FOREIGN' },
      },
    })
    const v = svc.validate(p.id)
    expect(v.status).toBe('invalid')
    expect(v.validation?.issues.join(' ')).toMatch(/dealstage/)
  })

  /**
   * The CONTROL for the two above: a type's OWN stage property must still pass validate
   * and be verified at preflight instead. A fix that denied every reserved name on every
   * type would pass the tests above and break the gate it is meant to close.
   */
  it('the type OWN stage property still validates and is verified at preflight instead', () => {
    const svc = reservedSvc(['tickets'])
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: 'tickets',
        objectId: '1',
        properties: { hs_pipeline_stage: 'anything' },
      },
    })
    expect(svc.validate(p.id).status).toBe('validated')
  })

  /**
   * A CHARACTERIZATION test, the peer of the bare-`pipeline` one in the N4 block below.
   * Bare `pipeline` is deliberately NOT in RESERVED_REFERENCE_PROPS, because it is a
   * plausible name for a customer's own property, and the published safety model says it
   * is not denied. It is `deals`' own pipeline property, so on `tickets` it is neither
   * resolvable nor reserved and the write is not denied. That belongs with the residual
   * the doc already discloses, not with this fix.
   */
  it('tickets setting bare pipeline stays undenied, the residual the doc discloses', () => {
    const svc = reservedSvc(['tickets'])
    const p = svc.draft({
      portalKey: 'PORTAL_A',
      operation: {
        kind: 'update',
        objectType: 'tickets',
        objectId: '1',
        properties: { pipeline: 'FOREIGN' },
      },
    })
    expect(svc.validate(p.id).status).toBe('validated')
  })

  /**
   * SAFETY.md "Each portal has a default-deny policy.", the sentence listing the properties
   * refused outright (#205), registered in scripts/claims-register.json.
   *
   * The sentence names EIGHT properties and a condition, so all eight are driven through
   * one policy that allow-lists every object type and both operations — which is what
   * "whatever your allow-lists say" means, and what the per-case unit tests above cannot
   * say, since each pins one name on one type.
   *
   * The condition is the half #186 changed. The page used to carve out deals and tickets
   * from the stage-field rule, and the gate was then stricter on the types it CANNOT verify
   * than on the two it can; the rule is now "wherever they do not belong to the object type
   * being written", which includes a reserved name belonging to the other known type.
   *
   * The last two cases are the CONTROL, and they are not optional: a gate that denied every
   * reserved name on every type would satisfy the eleven refusals above them and break the
   * verification path that a type's own stage property is meant to take at preflight.
   */
  it('each named owner, team and misplaced stage property is refused whatever the allow-lists say', () => {
    const svc = reservedSvc(['deals', 'tickets', 'contacts'])
    const verdict = (objectType: string, property: string): string => {
      const p = svc.draft({
        portalKey: 'PORTAL_A',
        operation: {
          kind: 'update',
          objectType,
          objectId: '900',
          properties: { [property]: 'FOREIGN' },
        },
      })
      const v = svc.validate(p.id)
      const named = v.validation?.issues.join(' ').includes(property) ?? false
      return v.status === 'invalid' && named ? 'refused' : v.status
    }
    const cases: Array<[string, string, string]> = [
      // The five owner and team fields: no in-target resolver, so they are denied outright.
      ['contacts', 'hubspot_owner_id', 'refused'],
      ['contacts', 'hubspot_team_id', 'refused'],
      ['contacts', 'hs_all_owner_ids', 'refused'],
      ['contacts', 'hs_all_team_ids', 'refused'],
      ['contacts', 'hs_created_by_user_id', 'refused'],
      // The three reserved stage fields, on a type they do not belong to: the other known
      // type, and a type this server cannot verify at all.
      ['tickets', 'dealstage', 'refused'],
      ['deals', 'hs_pipeline', 'refused'],
      ['deals', 'hs_pipeline_stage', 'refused'],
      ['contacts', 'dealstage', 'refused'],
      ['contacts', 'hs_pipeline', 'refused'],
      ['contacts', 'hs_pipeline_stage', 'refused'],
      // CONTROL: a type's OWN stage field is not refused here — it is verified in the
      // target portal at preflight instead.
      ['deals', 'dealstage', 'validated'],
      ['tickets', 'hs_pipeline_stage', 'validated'],
    ]
    expect(cases, 'no property was exercised, so this proves nothing').toHaveLength(13)
    expect(
      cases.map(
        ([objectType, property]) => `${objectType}/${property}: ${verdict(objectType, property)}`,
      ),
    ).toEqual(cases.map(([objectType, property, want]) => `${objectType}/${property}: ${want}`))
  })

  /**
   * SAFETY.md "Each portal has a default-deny policy.", the sentence "Those names are
   * matched as written, so an owner or pipeline property of your own under another name is
   * not recognised." (#205), registered in scripts/claims-register.json.
   *
   * The sentence #205 asked for, because the page used to describe this gate in
   * schema-aware language ("owner and team assignment fields"), and a reader with a custom
   * owner field believed they were covered. It is a CHARACTERIZATION of a real limit, so
   * the assertion is that these writes pass validate — the honest statement of what the
   * operator has to check themselves.
   *
   * The control is the same property under its HubSpot name. Without it, a gate that had
   * stopped denying anything at all would read as this limit being faithfully documented.
   */
  it('an owner or pipeline property under another name is not recognised, so it is not refused', () => {
    const svc = reservedSvc(['deals'])
    const statusFor = (properties: Record<string, string>): string => {
      const p = svc.draft({
        portalKey: 'PORTAL_A',
        operation: { kind: 'update', objectType: 'deals', objectId: '900', properties },
      })
      return svc.validate(p.id).status
    }
    const cases: Array<[string, Record<string, string>, string]> = [
      ['an owner field of your own', { account_owner: '55' }, 'validated'],
      ['a team field of your own', { owning_team: '9' }, 'validated'],
      ['a pipeline field of your own', { my_pipeline: 'FOREIGN' }, 'validated'],
      ['a stage field of your own', { my_stage: 'FOREIGN' }, 'validated'],
      // CONTROL: the same assignment written under the name the gate matches.
      ['the owner field under its HubSpot name', { hubspot_owner_id: '55' }, 'invalid'],
    ]
    expect(cases, 'no name was exercised, so this proves nothing').toHaveLength(5)
    expect(cases.map(([label, properties]) => `${label}: ${statusFor(properties)}`)).toEqual(
      cases.map(([label, , want]) => `${label}: ${want}`),
    )
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

  /**
   * SAFETY.md "Updates can be read back against the target portal before they run.",
   * the sentence (#204): "In `apply` mode, for the object types you list, both arguments are
   * ignored."
   *
   * Registered in scripts/claims-register.json. One of the two UNDERSTATED findings on
   * that ticket: the page was SCARIER than the code, which costs an operator's trust in
   * the rest of the page once they discover it themselves.
   *
   * "Both arguments" is the phrase under test, so both are exercised rather than one: they
   * are neutralized at the same site but they gate different things, and the first two
   * tests in this block each pin the refusal TEXT for one flag, which is a claim about
   * advice and not about the flags being inert. The third case is the exception the page
   * states in the same breath — ignored even on a plan an operator approved — which is the
   * condition a reader is most likely to assume restores them.
   *
   * Each refusal is matched on the "is ignored" clause, so a plan refused for any other
   * reason cannot count as proof.
   */
  it('in apply mode both execute arguments are ignored for a listed object type', async () => {
    // skipInspection: the read is still required.
    const unreadSvc = setup({ writeMode: 'apply' }).svc
    const unread = unreadSvc.draft({ portalKey: 'PORTAL_A', operation: updateUnseeded })
    unreadSvc.validate(unread.id)
    await expect(unreadSvc.execute(unread.id, { skipInspection: true })).rejects.toThrow(
      /skipInspection is ignored/,
    )

    // acceptMissingTargets: a target the read did not find is still refused.
    const missingSvc = setup({ writeMode: 'apply' }).svc
    const missing = missingSvc.draft({
      portalKey: 'PORTAL_A',
      operation: createWithMissingAssoc,
    })
    missingSvc.validate(missing.id)
    await missingSvc.inspectTarget(missing.id)
    await expect(missingSvc.execute(missing.id, { acceptMissingTargets: true })).rejects.toThrow(
      /acceptMissingTargets is ignored/,
    )

    // And an operator approval restores neither.
    const approvedSvc = setup({ writeMode: 'apply' }).svc
    const approved = approvedSvc.draft({
      portalKey: 'PORTAL_A',
      operation: createWithMissingAssoc,
    })
    approvedSvc.validate(approved.id)
    approvedSvc.approve(approved.id, expectedApprovalPhrase(approved.id, 'PORTAL_A'))
    await approvedSvc.inspectTarget(approved.id)
    await expect(
      approvedSvc.execute(approved.id, { skipInspection: true, acceptMissingTargets: true }),
    ).rejects.toThrow(/acceptMissingTargets is ignored/)
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
