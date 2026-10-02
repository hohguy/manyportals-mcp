import { describe, it, expect, vi } from 'vitest'
import {
  appendFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlDir, isWriterFile, newWriterId, parseJsonlStrict, writeAllSync } from './jsonl-dir.js'

// Wrap fsyncSync so a test can assert the durability call; every other fs
// function stays real (RT-03/04).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})

/** A temp data folder, removed after the test body runs. */
function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mp-jsonl-dir-'))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ID_A = newWriterId(new Date('2026-09-13T10:15:30.123Z'), 'aaaaaaaa')
const ID_B = newWriterId(new Date('2026-09-13T10:16:00.000Z'), 'bbbbbbbb')

describe('newWriterId', () => {
  it('is a compact UTC stamp plus a random suffix, and sorts by start time', () => {
    expect(ID_A).toBe('20260913T101530Z-aaaaaaaa')
    expect([ID_B, ID_A].sort()).toEqual([ID_A, ID_B])
    expect(newWriterId()).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/)
  })
})

describe('isWriterFile', () => {
  it('accepts a trail file and nothing else in the folder', () => {
    expect(isWriterFile(`${ID_A}.jsonl`)).toBe(true)
    for (const name of ['.DS_Store', 'audit.jsonl', `${ID_A}.jsonl.bak`, `${ID_A} (copy).jsonl`]) {
      expect(isWriterFile(name)).toBe(false)
    }
  })
})

describe('JsonlDir — several copies share one folder (#24)', () => {
  it('creates nothing until the first append, then writes its own owner-only file', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      const a = new JsonlDir(dir, ID_A)
      expect(a.readNew()).toEqual({ lines: [], tornTails: [], ignored: [] })
      expect(existsSync(dir)).toBe(false) // a copy that never writes leaves nothing

      vi.mocked(fsyncSync).mockClear()
      a.appendLine('{"n":1}')
      expect(existsSync(join(dir, `${ID_A}.jsonl`))).toBe(true)
      expect(fsyncSync).toHaveBeenCalled() // durable before returning
    })
  })

  it('each copy reads the others lines but never its own, and only the new ones', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      const a = new JsonlDir(dir, ID_A)
      const b = new JsonlDir(dir, ID_B)
      a.appendLine('{"from":"a1"}')
      b.appendLine('{"from":"b1"}')

      // Own lines stay out: the caller already holds them in memory.
      expect(a.readNew().lines).toEqual([{ file: `${ID_B}.jsonl`, text: '{"from":"b1"}' }])
      expect(b.readNew().lines.map((l) => l.text)).toEqual(['{"from":"a1"}'])

      // Offsets advance, so a second read returns only what arrived since.
      expect(a.readNew().lines).toEqual([])
      b.appendLine('{"from":"b2"}')
      expect(a.readNew().lines.map((l) => l.text)).toEqual(['{"from":"b2"}'])
    })
  })

  it('withholds a line another copy is still writing, and delivers it once complete', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      mkdirSync(dir, { recursive: true })
      const half = join(dir, `${ID_B}.jsonl`)
      const a = new JsonlDir(dir, ID_A)

      writeFileSync(half, '{"done":1}\n{"half":')
      const first = a.readNew()
      expect(first.lines.map((l) => l.text)).toEqual(['{"done":1}']) // never half a record
      expect(first.tornTails).toEqual([`${ID_B}.jsonl`])

      appendFileSync(half, '2}\n')
      expect(a.readNew().lines.map((l) => l.text)).toEqual(['{"half":2}'])
    })
  })

  it('ignores anything that is not a writer file instead of reading it as corruption', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '.DS_Store'), 'not json\n')
      writeFileSync(join(dir, `${ID_B}.jsonl.bak`), 'not json\n')
      writeFileSync(join(dir, `${ID_B} (conflicted copy).jsonl`), 'not json\n')
      writeFileSync(join(dir, `${ID_B}.jsonl`), '{"real":1}\n')

      const read = new JsonlDir(dir, ID_A).readNew()
      expect(read.lines.map((l) => l.text)).toEqual(['{"real":1}'])
      expect(read.ignored.sort()).toEqual(
        ['.DS_Store', `${ID_B} (conflicted copy).jsonl`, `${ID_B}.jsonl.bak`].sort(),
      )
    })
  })

  it('reads the legacy single-writer file first, and only once', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      const legacy = join(root, 'audit.jsonl')
      writeFileSync(legacy, '{"old":1}\n{"old":2}\n')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${ID_B}.jsonl`), '{"new":1}\n')

      const store = new JsonlDir(dir, ID_A, legacy)
      const read = store.readNew()
      expect(read.lines.map((l) => l.text)).toEqual(['{"old":1}', '{"old":2}', '{"new":1}'])
      expect(read.lines[0]?.file).toBe('audit.jsonl') // named for an operator
      expect(store.readNew().lines).toEqual([])
    })
  })

  it('throws (never silently returns nothing) when a path exists but cannot be read', () => {
    withDir((root) => {
      // Point the legacy path at a DIRECTORY → fails EISDIR, not ENOENT. Failing
      // open would hide history while appends keep succeeding.
      const store = new JsonlDir(join(root, 'audit.d'), ID_A, root)
      expect(() => store.readNew()).toThrow(/cannot read JSONL store/)
    })
  })

  it('fails loud when a trail file shrinks — an append-only file never does', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      mkdirSync(dir, { recursive: true })
      const other = join(dir, `${ID_B}.jsonl`)
      writeFileSync(other, '{"a":1}\n{"a":2}\n')
      const store = new JsonlDir(dir, ID_A)
      expect(store.readNew().lines).toHaveLength(2)

      writeFileSync(other, '{"a":1}\n') // truncated or replaced behind us
      expect(() => store.readNew()).toThrow(/shrank/)
    })
  })

  it('refuses to append again after an append failed part-way through a line', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      let calls = 0
      const failMidLine = (_fd: number, _buf: Buffer, _offset: number, _length: number): number => {
        calls += 1
        if (calls === 1) return 1 // a short write, accepted
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      const store = new JsonlDir(dir, ID_A, undefined, failMidLine)

      expect(() => store.appendLine('{"a":1}')).toThrow(/no space left/)
      // The file now ends mid-line. Appending again would land the next record on
      // that prefix and make one complete, unparseable line — corruption that
      // survives every restart and fails every other copy.
      expect(() => store.appendLine('{"a":2}')).toThrow(/failed part-way/)
    })
  })

  it('fails loud when another copy already holds this writer id', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${ID_A}.jsonl`), '{"theirs":1}\n') // another copy got there first
      expect(() => new JsonlDir(dir, ID_A).appendLine('{"mine":1}')).toThrow(/already exists/)
    })
  })
})

describe('parseJsonlStrict', () => {
  it('names the file an operator can open', () => {
    withDir((root) => {
      const dir = join(root, 'audit.d')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${ID_B}.jsonl`), '{"ok":1}\n{bad\n')
      const read = new JsonlDir(dir, ID_A).readNew()
      expect(() => parseJsonlStrict(read.lines)).toThrow(new RegExp(`${ID_B}\\.jsonl`))
    })
  })
})

describe('writeAllSync', () => {
  it('loops until every byte is written (a short write would truncate a line)', () => {
    const chunks: string[] = []
    const oneByteAtATime = (_fd: number, buf: Buffer, offset: number): number => {
      chunks.push(buf.subarray(offset, offset + 1).toString())
      return 1
    }
    writeAllSync(0, Buffer.from('{"a":1}\n'), oneByteAtATime)
    expect(chunks.join('')).toBe('{"a":1}\n')
  })

  it('throws rather than spin when the file system accepts no bytes', () => {
    expect(() => writeAllSync(0, Buffer.from('x'), () => 0)).toThrow(/accepted no bytes/)
  })
})

/**
 * A batch spans SEVERAL peer files, and a failure in a later one must not lose the
 * lines already taken from an earlier one (#82).
 *
 * readInto advanced its per-file offset as it handed lines into the batch, and
 * readNew then threw out of a later file, so the caller discarded the whole batch
 * while those offsets stayed advanced. Nothing re-read them for the life of the
 * process: the cross-portal guard reported a peer's id as unknown and recovered
 * silently, and peer audit events vanished from the log while still on disk.
 *
 * Every existing case here uses a SINGLE readable source, so the multi-file batch was
 * never exercised, and the shared fake throws before touching its offset, so no test
 * built on it could see the difference either (#83).
 */
describe('a failure part-way through a multi-file batch', () => {
  const PEER_1 = newWriterId(new Date('2026-01-01T00:00:01.000Z'), 'aaaaaaaa')
  const PEER_2 = newWriterId(new Date('2026-01-01T00:00:02.000Z'), 'bbbbbbbb')

  function texts(dir: JsonlDir): string[] {
    return dir.readNew().lines.map((l) => l.text)
  }

  it('loses nothing from the earlier file when a later one shrinks', () => {
    withDir((dir) => {
      const p1 = join(dir, `${PEER_1}.jsonl`)
      const p2 = join(dir, `${PEER_2}.jsonl`)
      writeFileSync(p1, 'one\n')
      writeFileSync(p2, 'two-aaaaaaaaaaaaaaaaaaaa\n')
      const store = new JsonlDir(dir, newWriterId(new Date(), 'cccccccc'))
      expect(texts(store).sort()).toEqual(['one', 'two-aaaaaaaaaaaaaaaaaaaa'])

      // Both peers append; then the LATER file is replaced by something shorter, as
      // a sync conflict, a restore, or an operator tidying trail files would do.
      appendFileSync(p1, 'three\n')
      appendFileSync(p2, 'four\n')
      writeFileSync(p2, 'x\n')
      expect(() => store.readNew()).toThrow(/shrank/)

      // The peer file is repaired. "three" was consumed into the discarded batch; if
      // its offset was committed anyway it is gone for the life of this process.
      writeFileSync(p2, 'two-aaaaaaaaaaaaaaaaaaaa\nfour\n')
      expect(texts(store)).toContain('three')
    })
  })

  it('loses nothing from the earlier file when a later one cannot be read', () => {
    withDir((dir) => {
      const p1 = join(dir, `${PEER_1}.jsonl`)
      const p2 = join(dir, `${PEER_2}.jsonl`)
      writeFileSync(p1, 'one\n')
      mkdirSync(p2) // a directory where a trail file belongs: fails loud, not empty
      const store = new JsonlDir(dir, newWriterId(new Date(), 'cccccccc'))
      expect(() => store.readNew()).toThrow()

      rmSync(p2, { recursive: true, force: true })
      writeFileSync(p2, 'two\n')
      expect(texts(store).sort()).toEqual(['one', 'two'])
    })
  })

  it('still advances offsets on a clean multi-file read, so lines are not repeated', () => {
    withDir((dir) => {
      writeFileSync(join(dir, `${PEER_1}.jsonl`), 'one\n')
      writeFileSync(join(dir, `${PEER_2}.jsonl`), 'two\n')
      const store = new JsonlDir(dir, newWriterId(new Date(), 'cccccccc'))
      expect(texts(store).sort()).toEqual(['one', 'two'])
      expect(texts(store)).toEqual([])
    })
  })
})

/**
 * The contract both implementations must honour, asserted against BOTH (#83).
 *
 * The shared fake threw before touching its offset while production advanced offsets
 * per file, so the fake was STRICTER than the code it stands in for. Every multi-copy
 * audit and id-index test runs on the fake, including the two whose stated purpose is
 * to prove fail-closed reads, and none of them could tell the two behaviours apart:
 * applying the production fix left that suite green while three direct probes flipped.
 * A fake that exceeds production robustness hides the very bug it is trusted to
 * reveal, so the rule is pinned here rather than left to a comment.
 */
describe('contract: a read that fails advances no offset', () => {
  it('holds for JsonlDir', () => {
    withDir((dir) => {
      const peer = join(
        dir,
        `${newWriterId(new Date('2026-01-01T00:00:01.000Z'), 'aaaaaaaa')}.jsonl`,
      )
      const blocker = join(
        dir,
        `${newWriterId(new Date('2026-01-01T00:00:02.000Z'), 'bbbbbbbb')}.jsonl`,
      )
      writeFileSync(peer, 'kept\n')
      mkdirSync(blocker) // a directory where a trail file belongs: fails loud
      const store = new JsonlDir(dir, newWriterId(new Date(), 'cccccccc'))
      expect(() => store.readNew()).toThrow()
      rmSync(blocker, { recursive: true, force: true })
      expect(store.readNew().lines.map((l) => l.text)).toEqual(['kept'])
    })
  })

  it('holds for FakeFolder', async () => {
    const { FakeFolder } = await import('./fake.js')
    const folder = new FakeFolder()
    folder.add('peer', { kept: true })
    const store = folder.storeFor('me')
    folder.readError = new Error('cannot read')
    expect(() => store.readNew()).toThrow()
    folder.readError = undefined
    expect(store.readNew().lines).toHaveLength(1)
  })
})
