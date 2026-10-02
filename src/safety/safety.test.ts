import { describe, it, expect } from 'vitest'
import {
  FilePortalIdIndex,
  PortalIdIndex,
  SafetyError,
  assertNoContamination,
  findContamination,
} from './index.js'
import { FakeFolder } from '../store/fake.js'

describe('findContamination', () => {
  it('flags an id seen only under another portal', () => {
    const idx = new PortalIdIndex()
    idx.record('PORTAL_A', '500')
    expect(findContamination(idx, 'PORTAL_B', ['500'])).toEqual([
      { id: '500', foreignPortals: ['PORTAL_A'] },
    ])
  })

  it('does NOT flag an id known to the target portal', () => {
    const idx = new PortalIdIndex()
    idx.record('PORTAL_B', '500')
    expect(findContamination(idx, 'PORTAL_B', ['500'])).toEqual([])
  })

  it('does NOT flag an id known to BOTH portals (same integer valid in both)', () => {
    const idx = new PortalIdIndex()
    idx.record('PORTAL_A', '500')
    idx.record('PORTAL_B', '500')
    expect(findContamination(idx, 'PORTAL_B', ['500'])).toEqual([])
  })

  it('does NOT flag a never-seen id (documented best-effort limitation)', () => {
    const idx = new PortalIdIndex()
    expect(findContamination(idx, 'PORTAL_B', ['999'])).toEqual([])
  })

  it('lists every foreign portal owning the id', () => {
    const idx = new PortalIdIndex()
    idx.record('PORTAL_A', '7')
    idx.record('PORTAL_C', '7')
    const hits = findContamination(idx, 'PORTAL_B', ['7'])
    expect(hits[0]?.foreignPortals.slice().sort()).toEqual(['PORTAL_A', 'PORTAL_C'])
  })
})

describe('assertNoContamination', () => {
  it('throws SafetyError naming ids + foreign portals (no secrets)', () => {
    const idx = new PortalIdIndex()
    idx.record('PORTAL_A', '500')
    let caught: unknown
    try {
      assertNoContamination(idx, 'PORTAL_B', ['500'])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SafetyError)
    const m = (caught as Error).message
    expect(m).toContain('500')
    expect(m).toContain('PORTAL_A')
    expect(m).toContain('PORTAL_B')
  })

  it('passes when ids are clean', () => {
    const idx = new PortalIdIndex()
    idx.record('PORTAL_B', '500')
    expect(() => assertNoContamination(idx, 'PORTAL_B', ['500'])).not.toThrow()
  })

  it('realistic: ids read under PORTAL_A then referenced in a write to PORTAL_B are blocked', () => {
    const idx = new PortalIdIndex()
    idx.recordMany('PORTAL_A', ['100', '200', '300']) // server read these under A
    expect(() => assertNoContamination(idx, 'PORTAL_B', ['200'])).toThrow(SafetyError)
  })
})

describe('FilePortalIdIndex — the guard is not blind after a restart', () => {
  it('persists attributions and replays them, so a foreign-portal id is still caught', () => {
    const folder = new FakeFolder()
    const index = new FilePortalIdIndex(folder.storeFor('w1'))
    index.record('PORTAL_A', '500')
    index.recordMany('PORTAL_A', ['600', '700'])
    expect(folder.lines).toHaveLength(3)

    // "restart": the next copy has a new writer id, so the old file is history to it.
    const reloaded = new FilePortalIdIndex(folder.storeFor('w2'))
    expect(reloaded.isKnownFor('PORTAL_A', '500')).toBe(true)
    const hits = findContamination(reloaded, 'PORTAL_B', ['500', '600'])
    expect(hits.map((h) => h.id).sort()).toEqual(['500', '600'])
    expect(hits[0]?.foreignPortals).toEqual(['PORTAL_A'])
  })

  it('keeps portals separate across reload (no cross-portal merge)', () => {
    const folder = new FakeFolder()
    const index = new FilePortalIdIndex(folder.storeFor('w1'))
    index.record('PORTAL_A', '1')
    index.record('PORTAL_B', '2')
    const reloaded = new FilePortalIdIndex(folder.storeFor('w2'))
    expect(reloaded.isKnownFor('PORTAL_A', '1')).toBe(true)
    expect(reloaded.isKnownFor('PORTAL_A', '2')).toBe(false)
    expect(reloaded.isKnownFor('PORTAL_B', '2')).toBe(true)
  })

  it('dedups on write: repeat reads append nothing; a different portal still appends (F3)', () => {
    const folder = new FakeFolder()
    const index = new FilePortalIdIndex(folder.storeFor('w1'))
    index.record('PORTAL_A', '500')
    index.record('PORTAL_A', '500') // repeat read of the same record
    index.recordMany('PORTAL_A', ['500', '500'])
    expect(folder.lines).toHaveLength(1) // one attribution, one line
    index.record('PORTAL_B', '500')
    expect(folder.lines).toHaveLength(2)
    expect(findContamination(index, 'PORTAL_C', ['500'])[0]?.foreignPortals.sort()).toEqual([
      'PORTAL_A',
      'PORTAL_B',
    ])
  })

  it('dedups across a reload too: hydrated ids do not re-append when re-read', () => {
    const folder = new FakeFolder()
    new FilePortalIdIndex(folder.storeFor('w1')).record('PORTAL_A', '9')
    const reloaded = new FilePortalIdIndex(folder.storeFor('w2')) // hydrates '9'
    reloaded.record('PORTAL_A', '9') // re-read after restart
    expect(folder.lines).toHaveLength(1)
  })

  it('reads what it can when a file ends mid-line, and warns once', () => {
    const folder = new FakeFolder()
    new FilePortalIdIndex(folder.storeFor('w1')).record('PORTAL_A', '1')
    folder.tornTails = ['20260913T101530Z-aaaaaaaa.jsonl']
    const warnings: string[] = []
    const index = new FilePortalIdIndex(folder.storeFor('w2'), undefined, (m) => warnings.push(m))
    expect(index.isKnownFor('PORTAL_A', '1')).toBe(true)
    expect(warnings[0]).toMatch(/ends mid-line/)
  })

  it('fails loud on corruption, at construction', () => {
    const folder = new FakeFolder()
    new FilePortalIdIndex(folder.storeFor('w1')).record('PORTAL_A', '1')
    folder.addRaw('w3', 'garbage')
    expect(() => new FilePortalIdIndex(folder.storeFor('w4'))).toThrow(/corrupt JSONL/)
  })

  it('rejects a line with no portal key or id', () => {
    const folder = new FakeFolder()
    folder.add('w1', { id: '5' })
    expect(() => new FilePortalIdIndex(folder.storeFor('w2'))).toThrow(/no portal key or id/)
  })
})

describe('FilePortalIdIndex — several copies share one folder (#24)', () => {
  it('sees an id another copy recorded, at validate and at execute', () => {
    const folder = new FakeFolder()
    const reader = new FilePortalIdIndex(folder.storeFor('reader'))
    const other = new FilePortalIdIndex(folder.storeFor('other'))

    // Nothing known yet: a write to PORTAL_B referencing 500 looks clean.
    expect(findContamination(reader, 'PORTAL_B', ['500'])).toEqual([])

    // Another copy reads that record under PORTAL_A while we are running.
    other.record('PORTAL_A', '500')

    // validate (findContamination) and execute (assertNoContamination) both catch it.
    expect(findContamination(reader, 'PORTAL_B', ['500'])).toEqual([
      { id: '500', foreignPortals: ['PORTAL_A'] },
    ])
    expect(() => assertNoContamination(reader, 'PORTAL_B', ['500'])).toThrow(SafetyError)
  })

  it('drops ids recorded for the same portal key under a different hub id', () => {
    const folder = new FakeFolder()
    const other = new FilePortalIdIndex(folder.storeFor('other'), () => 222)
    other.record('PORTAL_A', '500') // recorded when PORTAL_A meant hub 222

    const warnings: string[] = []
    const mine = new FilePortalIdIndex(
      folder.storeFor('mine'),
      () => 111,
      (m) => warnings.push(m),
    )
    expect(mine.isKnownFor('PORTAL_A', '500')).toBe(false) // not our PORTAL_A
    expect(warnings[0]).toMatch(/under hub 222/)
  })

  it('trusts a matching hub id, and lines written without one', () => {
    const folder = new FakeFolder()
    new FilePortalIdIndex(folder.storeFor('same'), () => 111).record('PORTAL_A', '1')
    folder.add('legacy', { portal: 'PORTAL_A', id: '2' })

    const mine = new FilePortalIdIndex(folder.storeFor('mine'), () => 111)
    expect(mine.isKnownFor('PORTAL_A', '1')).toBe(true)
    expect(mine.isKnownFor('PORTAL_A', '2')).toBe(true)
  })

  it('keeps failing after corruption instead of judging a write on a partial index', () => {
    const folder = new FakeFolder()
    const index = new FilePortalIdIndex(folder.storeFor('mine')) // clean at construction
    folder.add('other', { portal: 'PORTAL_A', id: '500' })
    folder.addRaw('other', '{bad')

    expect(() => findContamination(index, 'PORTAL_B', ['500'])).toThrow(/corrupt JSONL/)
    // The store has moved past that batch: a second check would otherwise judge the
    // write without the attribution above, having complained exactly once.
    expect(() => findContamination(index, 'PORTAL_B', ['500'])).toThrow(/corrupt JSONL/)
  })

  it('refuses the write when the other copies files cannot be read', () => {
    const folder = new FakeFolder()
    const index = new FilePortalIdIndex(folder.storeFor('mine'))
    folder.readError = new Error('EACCES: permission denied')
    expect(() => assertNoContamination(index, 'PORTAL_B', ['500'])).toThrow(/EACCES/)
  })
})
