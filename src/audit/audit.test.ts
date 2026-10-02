import { describe, it, expect } from 'vitest'
import {
  attributeToWriter,
  FileAuditLog,
  InMemoryAuditLog,
  LEGACY_WRITER,
  type AuditEvent,
} from './index.js'
import { FakeFolder } from '../store/fake.js'

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  type: 'draft',
  planId: 'p1',
  portalKey: 'PORTAL_A',
  at: 1,
  ...over,
})

describe('InMemoryAuditLog', () => {
  it('is append-only and queryable per portal and per plan', () => {
    const log = new InMemoryAuditLog()
    log.record({ type: 'draft', planId: 'p1', portalKey: 'PORTAL_A', at: 1 })
    log.record({ type: 'execute', planId: 'p1', portalKey: 'PORTAL_A', at: 2 })
    log.record({ type: 'draft', planId: 'p2', portalKey: 'PORTAL_B', at: 3 })
    expect(log.all()).toHaveLength(3)
    expect(log.forPortal('PORTAL_A')).toHaveLength(2)
    expect(log.forPlan('p2')).toHaveLength(1)
  })

  it('freezes events so they cannot be mutated after the fact', () => {
    const log = new InMemoryAuditLog()
    log.record({ type: 'draft', planId: 'p1', portalKey: 'PORTAL_A', at: 1 })
    const e = log.all()[0]!
    expect(() => {
      ;(e as { type: string }).type = 'execute'
    }).toThrow()
  })

  it('assigns monotonic 1-based sequence numbers', () => {
    const log = new InMemoryAuditLog()
    log.record({ type: 'draft', planId: 'p1', portalKey: 'PORTAL_A', at: 1 })
    log.record({ type: 'validate', planId: 'p1', portalKey: 'PORTAL_A', at: 2 })
    log.record({ type: 'execute', planId: 'p1', portalKey: 'PORTAL_A', at: 3 })
    expect(log.all().map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('deep-freezes event detail (nested detail cannot be mutated)', () => {
    const log = new InMemoryAuditLog()
    log.record({ type: 'fail', planId: 'p1', portalKey: 'PORTAL_A', at: 1, detail: { error: 'x' } })
    const e = log.all()[0]!
    expect(() => {
      ;(e.detail as { error: string }).error = 'tampered'
    }).toThrow()
  })

  it('all() returns a copy — mutating it cannot alter the internal trail', () => {
    const log = new InMemoryAuditLog()
    log.record({ type: 'draft', planId: 'p1', portalKey: 'PORTAL_A', at: 1 })
    const snapshot = log.all() as AuditEvent[]
    snapshot.push({ type: 'execute', planId: 'forged', portalKey: 'PORTAL_A', at: 2 })
    expect(log.all()).toHaveLength(1)
  })
})

describe('FileAuditLog — the trail survives a restart', () => {
  it('appends each event and replays the history on construction', () => {
    const folder = new FakeFolder()
    const log = new FileAuditLog(folder.storeFor('w1'))
    log.record(event({ at: 1 }))
    log.record(event({ type: 'execute', at: 2, detail: { objectId: '9' } }))
    expect(folder.lines).toHaveLength(2)

    // "restart": the next copy has a new writer id, so the old file is history to it.
    const reloaded = new FileAuditLog(folder.storeFor('w2'))
    expect(reloaded.all().map((e) => e.type)).toEqual(['draft', 'execute'])
    expect(reloaded.forPlan('p1')).toHaveLength(2)
    expect(reloaded.all()[1]?.detail?.objectId).toBe('9')
  })

  it('persists BEFORE memory: a failed append leaves NO event in the in-memory view', () => {
    const folder = new FakeFolder()
    const store = folder.storeFor('w1')
    const log = new FileAuditLog({
      ...store,
      appendLine() {
        throw new Error('disk full')
      },
    })
    expect(() => log.record(event())).toThrow(/disk full/)
    expect(log.all()).toHaveLength(0) // append failed → nothing durable → nothing queryable
  })

  it('fails loud on corruption, at construction', () => {
    const folder = new FakeFolder()
    new FileAuditLog(folder.storeFor('w1')).record(event())
    folder.addRaw('w2', '{bad')
    expect(() => new FileAuditLog(folder.storeFor('w3'))).toThrow(/corrupt JSONL/)
  })
})

describe('FileAuditLog — several copies share one folder (#24)', () => {
  it('each copy sees the others events, ordered by time, with the legacy trail first', () => {
    const folder = new FakeFolder()
    folder.add('legacy-file', {
      type: 'draft',
      planId: 'old',
      portalKey: 'PORTAL_A',
      at: 5,
      seq: 1,
    })
    const a = new FileAuditLog(folder.storeFor('wa'))
    const b = new FileAuditLog(folder.storeFor('wb'))
    a.record(event({ planId: 'pa', at: 7 }))
    b.record(event({ planId: 'pb', at: 6 }))

    expect(a.all().map((e) => e.planId)).toEqual(['old', 'pb', 'pa'])
    expect(b.all().map((e) => e.planId)).toEqual(['old', 'pb', 'pa'])
    // A legacy event (no writer on the line) is attributed to the legacy trail.
    expect(a.all()[0]?.writer).toBe('legacy')
  })

  it('orders events recorded in the same millisecond: legacy, then writer, then seq', () => {
    const folder = new FakeFolder()
    const at = 5
    folder.add('legacy-file', { type: 'draft', planId: 'legacy-one', portalKey: 'PORTAL_A', at })
    folder.add('wz', {
      type: 'draft',
      planId: 'z-two',
      portalKey: 'PORTAL_A',
      at,
      seq: 2,
      writer: 'wz',
    })
    folder.add('wz', {
      type: 'draft',
      planId: 'z-one',
      portalKey: 'PORTAL_A',
      at,
      seq: 1,
      writer: 'wz',
    })
    folder.add('wb', {
      type: 'draft',
      planId: 'b-one',
      portalKey: 'PORTAL_A',
      at,
      seq: 1,
      writer: 'wb',
    })

    const log = new FileAuditLog(folder.storeFor('wa'))
    expect(log.all().map((e) => e.planId)).toEqual(['legacy-one', 'b-one', 'z-one', 'z-two'])
  })

  it('keeps each writer sequence, so a missing line shows up as a gap', () => {
    const folder = new FakeFolder()
    const b = new FileAuditLog(folder.storeFor('wb'))
    b.record(event({ planId: 'p1', at: 1 }))
    b.record(event({ planId: 'p2', at: 2 }))
    b.record(event({ planId: 'p3', at: 3 }))
    expect(folder.lines.map((l) => (JSON.parse(l.text) as AuditEvent).seq)).toEqual([1, 2, 3])

    // Someone removes the middle line from wb's file. Another copy must still see
    // wb's own numbering — 1 then 3 — not a renumbered 1, 2.
    folder.lines.splice(1, 1)
    const a = new FileAuditLog(folder.storeFor('wa'))
    expect(a.all().map((e) => e.seq)).toEqual([1, 3])
    expect(a.all().map((e) => e.writer)).toEqual(['wb', 'wb'])
  })

  it('numbers its OWN events from one, however many the other copies wrote', () => {
    const folder = new FakeFolder()
    const b = new FileAuditLog(folder.storeFor('wb'))
    for (let i = 0; i < 5; i++) b.record(event({ planId: `b${i}`, at: i }))

    const a = new FileAuditLog(folder.storeFor('wa'))
    a.record(event({ planId: 'a1', at: 10 }))
    a.record(event({ planId: 'a2', at: 11 }))
    const own = a.all().filter((e) => e.writer === 'wa')
    expect(own.map((e) => e.seq)).toEqual([1, 2])
  })

  it('warns once per file about ignored files and torn tails, not on every query', () => {
    const folder = new FakeFolder()
    folder.ignored = ['audit.jsonl (conflicted copy)']
    folder.tornTails = ['20260913T101530Z-aaaaaaaa.jsonl']
    const warnings: string[] = []
    const log = new FileAuditLog(folder.storeFor('wa'), (m) => warnings.push(m))
    log.all()
    log.all()
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/ignoring "audit.jsonl \(conflicted copy\)"/)
    expect(warnings[1]).toMatch(/ends mid-line/)
  })
})

describe('attributeToWriter — one definition of the legacy attribution (#49)', () => {
  it('keeps a real writer id and names an unattributed event legacy', () => {
    expect(attributeToWriter(event({ writer: 'w1', seq: 3 })).writer).toBe('w1')
    expect(attributeToWriter(event()).writer).toBe('legacy')
    // Pinned: the read side presents this string to the model, so renaming it is a
    // visible contract change, not an internal detail.
    expect(LEGACY_WRITER).toBe('legacy')
  })

  it('does not alter the event it was given', () => {
    const original = event()
    attributeToWriter(original)
    expect(original.writer).toBeUndefined()
  })

  it('names a BLANK writer legacy too — `??` alone would keep the empty string', () => {
    // toStoredEvent validates type/planId/portalKey/at and never checks `writer`, so a
    // hand-edited or corrupted line can carry one of these. Our own ids are never blank
    // (newWriterId is `<stamp>-<hex>`), so this is the malformed-file case — precisely
    // when an audit trail must name the event honestly rather than leave it unattributed.
    expect(attributeToWriter(event({ writer: '' })).writer).toBe(LEGACY_WRITER)
    expect(attributeToWriter(event({ writer: '   ' })).writer).toBe(LEGACY_WRITER)
    // …while a real id with incidental whitespace is still that writer, not legacy.
    expect(attributeToWriter(event({ writer: ' w1 ' })).writer).toBe('w1')
  })
})

describe('FileAuditLog — a bad read must not answer from a partial trail (#24)', () => {
  it('keeps failing after corruption instead of quietly skipping the batch', () => {
    const folder = new FakeFolder()
    const log = new FileAuditLog(folder.storeFor('wa')) // clean at construction
    folder.add('wb', { type: 'draft', planId: 'good', portalKey: 'PORTAL_A', at: 1, writer: 'wb' })
    folder.addRaw('wb', '{bad')

    expect(() => log.all()).toThrow(/corrupt JSONL/)
    // The store has already moved past that batch, so answering now would return a
    // trail missing the good line above — and say so only the first time.
    expect(() => log.all()).toThrow(/corrupt JSONL/)
  })

  it('refuses a line that is not an audit event, rather than handing it to the model', () => {
    const folder = new FakeFolder()
    const log = new FileAuditLog(folder.storeFor('wa'))
    folder.addRaw('wb', JSON.stringify({}))
    expect(() => log.all()).toThrow(/missing type, planId, portalKey or at/)
  })

  it('surfaces a store read failure instead of returning what it has', () => {
    const folder = new FakeFolder()
    const log = new FileAuditLog(folder.storeFor('wa'))
    folder.readError = new Error('EACCES: permission denied')
    expect(() => log.all()).toThrow(/EACCES/)
  })
})
